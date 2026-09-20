import { WorkflowStatus, ApprovalGateType } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getOrganizationId } from "../../context/tenant.js";
import { authorizationService } from "../../services/authorization.service.js";
import { organizationService } from "../../services/organization.service.js";
import { whatsappService } from "../../services/whatsapp.service.js";
import { approvalService } from "../../services/approval.service.js";
import { auditService } from "../../services/audit.service.js";
import { emailService, type EmailAttachment } from "../../services/email.service.js";
import { xeroService } from "../../services/xero.service.js";
import { ocrService } from "../../services/ocr.service.js";
import { llmService } from "../../services/llm.service.js";
import { saveUploadedFile } from "../../utils/storage.js";
import type {
  WhatsAppInboundMessage,
  PayableList,
  SoaExtraction,
  SoaCompareResult,
} from "../../types/index.js";
import { enqueueJob } from "../../jobs/queue.js";
import {
  compareSoaToXero,
  getPreviousMonth,
  parseReconcilePeriod,
  matchSupplierNameInText,
} from "../../utils/matching.js";
import { logDone, logStep } from "../../utils/workflow-log.js";
import { notifySupervisorOfXeroError } from "../../utils/xero-error.js";

interface ReconciliationPayload {
  supplierId: string;
  notifyPhone: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  soaFilePath?: string;
  soaExtraction?: SoaExtraction;
  sourceChoice?: "xero" | "request-soa";
  priorScope?: "full" | "current" | "custom";
  customAmount?: number;
  comparison?: SoaCompareResult;
  reconciliationId?: string;
}

export const reconciliationWorkflow = {
  async startFromDm(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    const isAuthorized = await authorizationService.isSupervisor(message.from);
    if (!isAuthorized) return;

    const organizationId = getOrganizationId();
    const text = message.text ?? "";
    const suppliers = await prisma.supplier.findMany({
      where: { organizationId, isActive: true },
      orderBy: { name: "asc" },
    });
    const matchedName = matchSupplierNameInText(
      text,
      suppliers.map((supplier) => supplier.name)
    );
    const supplier = matchedName
      ? suppliers.find((item) => item.name === matchedName)
      : null;

    if (!supplier) {
      await whatsappService.sendText(
        message.from,
        "Which supplier should I reconcile? Please include the supplier name."
      );
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    const period = parseReconcilePeriod(text);
    if (!period) {
      await this.askPeriod(workflowRunId, supplier.id, message.from);
      return;
    }

    await this.begin(workflowRunId, supplier.id, message.from, period);
  },

  async startFromGroup(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    const supplier = message.groupId
      ? await authorizationService.getSupplierByGroupId(message.groupId)
      : null;

    const supervisorPhone =
      (await organizationService.getSupervisorPhone(getOrganizationId())) ?? "+6590000000";

    if (!supplier) {
      await whatsappService.sendText(
        supervisorPhone,
        "Could not infer supplier from group. Please reconcile via DM with supplier name."
      );
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    const period = parseReconcilePeriod(message.text ?? "");
    if (!period) {
      await this.askPeriod(workflowRunId, supplier.id, supervisorPhone);
      return;
    }

    await this.begin(workflowRunId, supplier.id, supervisorPhone, period);
  },

  async startFromSoaDocument(
    workflowRunId: string,
    attachment: EmailAttachment,
    supplierId?: string
  ): Promise<void> {
    const organizationId = getOrganizationId();
    const supervisorPhone =
      (await organizationService.getSupervisorPhone(organizationId)) ?? "+6590000000";
    const supplier =
      (supplierId
        ? await prisma.supplier.findUnique({ where: { id: supplierId } })
        : await authorizationService.getSupplierByEmailDomain(attachment.from)) ?? null;

    if (!supplier) {
      await whatsappService.sendText(
        supervisorPhone,
        `New SOA arrived from ${attachment.from} (${attachment.filename}) but I could not match a supplier.`
      );
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    const filePath = await saveUploadedFile(attachment.content, attachment.filename);
    const period = getPreviousMonth();
    const payload: ReconciliationPayload = {
      supplierId: supplier.id,
      notifyPhone: supervisorPhone,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      periodLabel: period.label,
      soaFilePath: filePath,
    };
    await this.savePayload(workflowRunId, payload, "3.0-new-soa");
    await approvalService.create({
      workflowRunId,
      gateType: ApprovalGateType.NEW_SOA_DETECTION,
      question: `A new SOA arrived for ${supplier.name} (${attachment.filename}). Reconcile it now for ${period.label}?`,
      options: ["yes", "no"],
    });
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: WorkflowStatus.AWAITING_APPROVAL },
    });
  },

  async askPeriod(workflowRunId: string, supplierId: string, notifyPhone: string): Promise<void> {
    const payload: ReconciliationPayload = {
      supplierId,
      notifyPhone,
      periodStart: "",
      periodEnd: "",
      periodLabel: "",
    };
    await this.savePayload(workflowRunId, payload, "3.0-period", WorkflowStatus.AWAITING_APPROVAL);
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } });
    await this.createPeriodApproval(workflowRunId, supplier.name);
  },

  async createPeriodApproval(
    workflowRunId: string,
    supplierName: string,
    extra?: string
  ): Promise<void> {
    const question = [
      extra,
      `Which period should I reconcile for ${supplierName}?`,
      "",
      "Reply with one of these formats:",
      "• Month: September 2026",
      "• Date range: 01/09/2026 - 30/09/2026",
      "• All: all",
    ]
      .filter(Boolean)
      .join("\n");
    await approvalService.create({
      workflowRunId,
      gateType: ApprovalGateType.FIELD_CONFIRMATION,
      question,
      options: ["September 2026", "01/09/2026 - 30/09/2026", "all"],
    });
  },

  async begin(
    workflowRunId: string,
    supplierId: string,
    notifyPhone: string,
    period: { start: Date; end: Date; label: string }
  ): Promise<void> {
    const payload: ReconciliationPayload = {
      supplierId,
      notifyPhone,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      periodLabel: period.label,
    };
    await this.savePayload(workflowRunId, payload, "3.1-search-soa", WorkflowStatus.IN_PROGRESS);
    logStep(workflowRunId, "Reconciliation started", `${period.label} · supplier ${supplierId}`);
    await this.searchAndContinue(workflowRunId);
  },

  async searchAndContinue(workflowRunId: string): Promise<void> {
    const payload = await this.getPayload(workflowRunId);
    if (!payload) return;
    if (!payload.periodStart || !payload.periodEnd) {
      await this.askPeriod(workflowRunId, payload.supplierId, payload.notifyPhone);
      return;
    }
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: payload.supplierId } });

    if (!payload.soaFilePath) {
      const emails = await emailService.scanInvoiceInbox();
      const soa = emails.find(
        (item) =>
          item.kind === "soa" &&
          (item.from.toLowerCase().includes((supplier.emailDomain ?? "").toLowerCase()) ||
            item.subject.toLowerCase().includes(supplier.name.toLowerCase()))
      );
      if (soa) {
        payload.soaFilePath = await saveUploadedFile(soa.content, soa.filename);
      }
    }

    if (!payload.soaFilePath && payload.sourceChoice !== "xero") {
      await this.savePayload(workflowRunId, payload, "3.2-source-choice", WorkflowStatus.AWAITING_APPROVAL);
      await approvalService.create({
        workflowRunId,
        gateType: ApprovalGateType.RECONCILIATION_SOURCE_CHOICE,
        question: `No SOA found for ${supplier.name} (${payload.periodLabel}). Reconcile using Xero only, or request an SOA from the supplier?`,
        options: ["xero", "request soa"],
      });
      return;
    }

    if (payload.soaFilePath && !payload.soaExtraction) {
      const extracted = await ocrService.extractFromFile(payload.soaFilePath);
      payload.soaExtraction = await llmService.extractSoa(extracted.rawText);
      if (!payload.soaExtraction.invoices.length) {
        payload.soaExtraction = {
          invoices: [
            {
              invoiceNumber: extracted.extraction.invoiceNumber.value,
              amount: extracted.extraction.total.value,
            },
          ],
          balanceDue: extracted.extraction.total.value,
        };
      }
    }

    await this.compareAndContinue(workflowRunId, payload);
  },

  async compareAndContinue(workflowRunId: string, payload: ReconciliationPayload): Promise<void> {
    try {
      await this.compareAndContinueUnsafe(workflowRunId, payload);
    } catch (error) {
      await notifySupervisorOfXeroError("reconcile against Xero bills", error, payload.notifyPhone);
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
    }
  },

  async compareAndContinueUnsafe(workflowRunId: string, payload: ReconciliationPayload): Promise<void> {
    const organizationId = getOrganizationId();
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: payload.supplierId } });
    const start = new Date(payload.periodStart);
    const end = new Date(payload.periodEnd);

    const xeroBills = await xeroService.getBillsForPeriod(
      organizationId,
      supplier.xeroContactId ?? supplier.id,
      start,
      end
    );
    const older = await prisma.xeroBill.findMany({
      where: {
        supplierId: supplier.id,
        status: { in: ["SUBMITTED", "AWAITING_PAYMENT"] },
        invoiceDate: { lt: start },
      },
    });

    const comparison = payload.soaExtraction
      ? compareSoaToXero(
          payload.soaExtraction.invoices,
          xeroBills.map((bill) => ({
            invoiceNumber: bill.invoiceNumber,
            amount: bill.total,
            xeroBillId: bill.xeroBillId,
          }))
        )
      : {
          matched: xeroBills.map((bill) => ({
            invoiceNumber: bill.invoiceNumber,
            amount: bill.total,
            xeroBillId: bill.xeroBillId,
          })),
          missingFromXero: [],
          amountMismatch: [],
          xeroAbsentFromSoa: [],
        };

    payload.comparison = comparison;

    if (comparison.amountMismatch.length && payload.sourceChoice !== "xero") {
      await this.savePayload(workflowRunId, payload, "3.4-mismatch", WorkflowStatus.AWAITING_APPROVAL);
      await approvalService.create({
        workflowRunId,
        gateType: ApprovalGateType.MISMATCH_RESOLUTION,
        question: [
          `Amount mismatches for ${supplier.name}:`,
          ...comparison.amountMismatch.map(
            (row) =>
              `- ${row.invoiceNumber}: SOA S$${row.soaAmount.toFixed(2)} vs Xero S$${row.xeroAmount.toFixed(2)}`
          ),
          "Reply *yes* to continue with Xero amounts, or describe the correction.",
        ].join("\n"),
      });
      return;
    }

    if (older.length && !payload.priorScope) {
      await this.savePayload(workflowRunId, payload, "3.5-prior-balance", WorkflowStatus.AWAITING_APPROVAL);
      await approvalService.create({
        workflowRunId,
        gateType: ApprovalGateType.PRIOR_BALANCE_SCOPE,
        question: `${supplier.name} has ${older.length} older unpaid bill(s) totaling S$${older
          .reduce((sum, bill) => sum + Number(bill.totalAmount ?? 0), 0)
          .toFixed(2)}. Pay *full* outstanding, *current* month only, or a custom amount?`,
        options: ["full", "current", "custom"],
      });
      return;
    }

    if (comparison.missingFromXero.length) {
      if (supplier.whatsappGroupId) {
        await whatsappService.sendGroupText(
          supplier.whatsappGroupId,
          `Please send invoice(s): ${comparison.missingFromXero.map((row) => row.invoiceNumber).join(", ")}`
        );
      }
      const recon = await this.persistRun(payload, "AWAITING_MISSING_INVOICES");
      await whatsappService.sendText(
        payload.notifyPhone,
        `Asked ${supplier.name} for missing invoice(s): ${comparison.missingFromXero
          .map((row) => row.invoiceNumber)
          .join(", ")}. I will wait for the file and confirm goods received before creating bills.`
      );
      await this.finish(workflowRunId, WorkflowStatus.COMPLETED, { reconciliationId: recon.id });
      return;
    }

    await this.completePayableList(workflowRunId, payload, older);
  },

  async completePayableList(
    workflowRunId: string,
    payload: ReconciliationPayload,
    older: Array<{ invoiceNumber: string | null; totalAmount: unknown; xeroBillId: string | null; id: string }>
  ): Promise<void> {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: payload.supplierId } });
    const comparison = payload.comparison!;
    let items = comparison.matched.map((row) => ({
      invoiceNumber: row.invoiceNumber,
      amount: row.amount,
      xeroBillId: row.xeroBillId ?? row.invoiceNumber,
    }));

    if (payload.priorScope === "full") {
      items = [
        ...items,
        ...older.map((bill) => ({
          invoiceNumber: bill.invoiceNumber ?? "UNKNOWN",
          amount: Number(bill.totalAmount ?? 0),
          xeroBillId: bill.xeroBillId ?? bill.id,
        })),
      ];
    } else if (payload.priorScope === "custom" && payload.customAmount) {
      items.push({
        invoiceNumber: "CUSTOM",
        amount: payload.customAmount,
        xeroBillId: "custom",
      });
    }

    const payableList: PayableList = {
      supplierId: supplier.id,
      supplierName: supplier.name,
      period: payload.periodLabel,
      items,
      totalAmount: items.reduce((sum, item) => sum + item.amount, 0),
      referenceText: payload.periodLabel,
    };

    const soaTotal = payload.soaExtraction?.balanceDue ?? payableList.totalAmount;
    const xeroTotal = comparison.matched.reduce((sum, row) => sum + row.amount, 0);
    const recon = await this.persistRun(payload, "COMPLETED", payableList, {
      soaTotal,
      xeroTotal,
      matched: comparison.matched.length,
      missingFromXero: comparison.missingFromXero.map((row) => row.invoiceNumber),
      amountMismatch: comparison.amountMismatch,
      xeroAbsentFromSoa: comparison.xeroAbsentFromSoa,
    });

    const summary = [
      `Reconciliation: ${supplier.name} — ${payload.periodLabel}`,
      "",
      `SOA total: S$${soaTotal.toFixed(2)}`,
      `Xero total: S$${xeroTotal.toFixed(2)}`,
      `Matched: ${comparison.matched.length}`,
      `Missing from Xero: ${comparison.missingFromXero.map((row) => row.invoiceNumber).join(", ") || "none"}`,
      `Amount mismatches: ${comparison.amountMismatch.length}`,
      `Xero bills absent from SOA: ${comparison.xeroAbsentFromSoa.map((row) => row.invoiceNumber).join(", ") || "none"}`,
      "",
      "Payable list:",
      ...payableList.items.map((item) => `- ${item.invoiceNumber} S$${item.amount.toFixed(2)}`),
      `Total: S$${payableList.totalAmount.toFixed(2)}`,
    ].join("\n");

    await whatsappService.sendText(payload.notifyPhone, summary);
    logDone(
      workflowRunId,
      "Reconciliation complete",
      `${supplier.name} · payable S$${payableList.totalAmount.toFixed(2)}`
    );
    await this.finish(workflowRunId, WorkflowStatus.COMPLETED, { reconciliationId: recon.id });
    await auditService.log({
      workflowRunId,
      triggerEvent: "reconciliation.completed",
      actor: "reconciliation",
      sourceChannel: "whatsapp",
      outputs: { reconciliationId: recon.id, payableList },
      outcome: "success",
    });
    await enqueueJob("reconciliation.payable.ready", {
      reconciliationRunId: recon.id,
      organizationId: getOrganizationId(),
    });
  },

  async persistRun(
    payload: ReconciliationPayload,
    status: string,
    payableList?: PayableList,
    summary?: object
  ) {
    return prisma.reconciliationRun.create({
      data: {
        supplierId: payload.supplierId,
        periodStart: new Date(payload.periodStart),
        periodEnd: new Date(payload.periodEnd),
        soaFilePath: payload.soaFilePath,
        soaExtraction: payload.soaExtraction as object | undefined,
        payableList: payableList as object | undefined,
        summary: (summary ?? {
          missing: payload.comparison?.missingFromXero.map((row) => row.invoiceNumber),
        }) as object,
        status,
      },
    });
  },

  async onApprovalResolved(
    workflowRunId: string,
    gateType: ApprovalGateType,
    response: string
  ): Promise<void> {
    const payload = await this.getPayload(workflowRunId);
    if (!payload) {
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
      return;
    }
    const lower = response.trim().toLowerCase();

    if (gateType === ApprovalGateType.FIELD_CONFIRMATION) {
      const period = parseReconcilePeriod(response);
      if (!period) {
        const supplier = await prisma.supplier.findUniqueOrThrow({
          where: { id: payload.supplierId },
        });
        await prisma.workflowRun.update({
          where: { id: workflowRunId },
          data: { status: WorkflowStatus.AWAITING_APPROVAL },
        });
        await this.createPeriodApproval(
          workflowRunId,
          supplier.name,
          "I could not read that period. Please use the format below."
        );
        return;
      }
      await this.begin(workflowRunId, payload.supplierId, payload.notifyPhone, period);
      return;
    }

    if (gateType === ApprovalGateType.NEW_SOA_DETECTION) {
      if (lower === "no") {
        await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
        return;
      }
      await this.searchAndContinue(workflowRunId);
      return;
    }

    if (gateType === ApprovalGateType.RECONCILIATION_SOURCE_CHOICE) {
      if (lower.includes("request")) {
        const supplier = await prisma.supplier.findUniqueOrThrow({
          where: { id: payload.supplierId },
        });
        if (supplier.whatsappGroupId) {
          await whatsappService.sendGroupText(
            supplier.whatsappGroupId,
            `Please send the statement of account for ${payload.periodLabel}.`
          );
        }
        await whatsappService.sendText(
          payload.notifyPhone,
          `Asked ${supplier.name} for an SOA. I will continue when it arrives.`
        );
        await this.finish(workflowRunId, WorkflowStatus.COMPLETED);
        return;
      }
      payload.sourceChoice = "xero";
      await this.savePayload(workflowRunId, payload);
      await this.searchAndContinue(workflowRunId);
      return;
    }

    if (gateType === ApprovalGateType.MISMATCH_RESOLUTION) {
      if (payload.comparison) payload.comparison.amountMismatch = [];
      await this.savePayload(workflowRunId, payload);
      await this.compareAndContinue(workflowRunId, payload);
      return;
    }

    if (gateType === ApprovalGateType.PRIOR_BALANCE_SCOPE) {
      if (lower.startsWith("full")) payload.priorScope = "full";
      else if (lower.startsWith("custom") || /\d/.test(lower)) {
        payload.priorScope = "custom";
        const amount = parseFloat(response.replace(/[^0-9.]/g, ""));
        payload.customAmount = Number.isFinite(amount) ? amount : 0;
      } else payload.priorScope = "current";
      await this.savePayload(workflowRunId, payload);
      const older = await prisma.xeroBill.findMany({
        where: {
          supplierId: payload.supplierId,
          status: { in: ["SUBMITTED", "AWAITING_PAYMENT"] },
          invoiceDate: { lt: new Date(payload.periodStart) },
        },
      });
      if (payload.comparison?.missingFromXero.length) {
        await this.compareAndContinue(workflowRunId, payload);
        return;
      }
      await this.completePayableList(workflowRunId, payload, older);
    }
  },

  async savePayload(
    workflowRunId: string,
    payload: ReconciliationPayload,
    currentStep?: string,
    status?: WorkflowStatus
  ): Promise<void> {
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        payload: payload as object,
        ...(currentStep ? { currentStep } : {}),
        ...(status ? { status } : {}),
      },
    });
  },

  async getPayload(workflowRunId: string): Promise<ReconciliationPayload | null> {
    const run = await prisma.workflowRun.findUnique({ where: { id: workflowRunId } });
    return (run?.payload as ReconciliationPayload | null) ?? null;
  },

  async finish(workflowRunId: string, status: WorkflowStatus, result?: object): Promise<void> {
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status, completedAt: new Date(), ...(result ? { result } : {}) },
    });
  },
};
