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
import { listInFlightBillIds } from "../../utils/payment-batch.js";

interface ReconciliationPayload {
  supplierId: string;
  notifyPhone: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  soaFilePath?: string;
  soaExtraction?: SoaExtraction;
  sourceChoice?: "xero" | "email" | "request-soa";
  imapSearched?: boolean;
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
        "Which supplier should I reconcile? Include the name, for example:\nPlease reconcile payment for Fresh Farms"
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
        `A group asked me to reconcile, but I couldn't tell which supplier that chat belongs to. Please DM me with the supplier name, for example:\nPlease reconcile payment for Fresh Farms`
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
        `A new statement of account arrived from ${attachment.from} (${attachment.filename}), but I couldn't match it to a supplier. Please add or check that supplier's email domain, then ask me to reconcile.`
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
      question: `A new statement of account arrived for *${supplier.name}* (${attachment.filename}). Reconcile ${period.label} now?`,
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
      `Which period should I reconcile for *${supplierName}*?`,
      "",
      "You can reply with:",
      "• a month — September 2026",
      "• a date range — 01/09/2026 - 30/09/2026",
      "• *all* unpaid bills",
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
    await this.savePayload(workflowRunId, payload, "3.1-source", WorkflowStatus.AWAITING_APPROVAL);
    logStep(workflowRunId, "Reconciliation started", `${period.label} · supplier ${supplierId}`);
    if (payload.soaFilePath) {
      await this.searchAndContinue(workflowRunId);
      return;
    }
    await this.askSourceChoice(workflowRunId, payload);
  },

  async askSourceChoice(workflowRunId: string, payload: ReconciliationPayload): Promise<void> {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: payload.supplierId } });
    const afterImapMiss = Boolean(payload.imapSearched);
    await this.savePayload(workflowRunId, payload, "3.2-source-choice", WorkflowStatus.AWAITING_APPROVAL);
    await approvalService.create({
      workflowRunId,
      gateType: ApprovalGateType.RECONCILIATION_SOURCE_CHOICE,
      question: afterImapMiss
        ? [
            `I couldn't find a statement of account for *${supplier.name}* in the invoice inbox (${payload.periodLabel}).`,
            "",
            "*xero* — continue with unpaid Xero bills only",
            "*request soa* — ask the supplier to send a statement",
          ].join("\n")
        : [
            `How should I reconcile *${supplier.name}* for *${payload.periodLabel}*?`,
            "",
            "*xero* — unpaid bills in Xero only (usually a few seconds)",
            "*email* — look for their statement in the invoice inbox, then compare it to Xero (can take a minute)",
          ].join("\n"),
      options: afterImapMiss ? ["xero", "request soa"] : ["xero", "email"],
    });
  },

  async searchAndContinue(workflowRunId: string): Promise<void> {
    const payload = await this.getPayload(workflowRunId);
    if (!payload) return;
    if (!payload.periodStart || !payload.periodEnd) {
      await this.askPeriod(workflowRunId, payload.supplierId, payload.notifyPhone);
      return;
    }
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: payload.supplierId } });

    if (!payload.soaFilePath && payload.sourceChoice === "email" && !payload.imapSearched) {
      payload.imapSearched = true;
      await this.savePayload(workflowRunId, payload, "3.2-imap", WorkflowStatus.IN_PROGRESS);
      await whatsappService.sendText(
        payload.notifyPhone,
        `Looking in the invoice inbox for a statement from *${supplier.name}*…`
      );
      const emails = await emailService.scanInvoiceInbox({ soaOnly: true });
      const domain = (supplier.emailDomain ?? "").toLowerCase();
      const soa = emails.find(
        (item) =>
          item.kind === "soa" &&
          ((domain && item.from.toLowerCase().includes(domain)) ||
            item.subject.toLowerCase().includes(supplier.name.toLowerCase()))
      );
      if (soa) {
        payload.soaFilePath = await saveUploadedFile(soa.content, soa.filename);
      }
    }

    if (!payload.soaFilePath && payload.sourceChoice !== "xero") {
      await this.askSourceChoice(workflowRunId, payload);
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

    if (payload.sourceChoice === "xero" && !payload.soaFilePath) {
      logStep(workflowRunId, "Xero-only reconcile — skipping inbox", supplier.name);
      await whatsappService.sendText(
        payload.notifyPhone,
        `Checking unpaid Xero bills for *${supplier.name}*…`
      );
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

    const { unpaid: fetchedUnpaid, paid: paidXeroBills } = await xeroService.getReconciliationBillsForPeriod(
      organizationId,
      supplier.xeroContactId ?? supplier.id,
      start,
      end
    );
    const inFlightIds = await listInFlightBillIds(supplier.id);
    const xeroBills = fetchedUnpaid.filter((bill) => !inFlightIds.has(bill.xeroBillId));
    const older = (await prisma.xeroBill.findMany({
      where: {
        supplierId: supplier.id,
        status: { in: ["SUBMITTED", "AWAITING_PAYMENT"] },
        invoiceDate: { lt: start },
      },
    })).filter((bill) => !inFlightIds.has(bill.xeroBillId ?? bill.id));

    const comparison = payload.soaExtraction
      ? compareSoaToXero(
          payload.soaExtraction.invoices,
          xeroBills.map((bill) => ({
            invoiceNumber: bill.invoiceNumber,
            amount: bill.total,
            xeroBillId: bill.xeroBillId,
          })),
          paidXeroBills.map((bill) => ({
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
          alreadyPaid: [],
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
          `Amount differences for *${supplier.name}*:`,
          ...comparison.amountMismatch.map(
            (row) =>
              `• ${row.invoiceNumber}: SOA S$${row.soaAmount.toFixed(2)} vs Xero S$${row.xeroAmount.toFixed(2)}`
          ),
          "",
          "Reply *yes* to continue with the Xero amounts, or tell me what to correct.",
        ].join("\n"),
      });
      return;
    }

    if (older.length && !payload.priorScope) {
      await this.savePayload(workflowRunId, payload, "3.5-prior-balance", WorkflowStatus.AWAITING_APPROVAL);
      await approvalService.create({
        workflowRunId,
        gateType: ApprovalGateType.PRIOR_BALANCE_SCOPE,
        question: `*${supplier.name}* also has ${older.length} older unpaid bill(s) totaling S$${older
          .reduce((sum, bill) => sum + Number(bill.totalAmount ?? 0), 0)
          .toFixed(2)}.\n\nPay the *full* outstanding, *current* period only, or a *custom* amount?`,
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
        `I asked *${supplier.name}* for invoice(s) ${comparison.missingFromXero
          .map((row) => row.invoiceNumber)
          .join(", ")}. I'll wait for the file, then confirm with you that the goods were received before creating bills.`
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
      alreadyPaid: comparison.alreadyPaid.map((row) => row.invoiceNumber),
      missingFromXero: comparison.missingFromXero.map((row) => row.invoiceNumber),
      amountMismatch: comparison.amountMismatch,
      xeroAbsentFromSoa: comparison.xeroAbsentFromSoa,
    });

    const none = "none";
    const paid = comparison.alreadyPaid.map((row) => row.invoiceNumber).join(", ") || none;
    const missing = comparison.missingFromXero.map((row) => row.invoiceNumber).join(", ") || none;
    const absent = comparison.xeroAbsentFromSoa.map((row) => row.invoiceNumber).join(", ") || none;
    const summary = [
      `*Reconciliation — ${supplier.name}*`,
      `Period: ${payload.periodLabel}`,
      "",
      `Statement total: S$${soaTotal.toFixed(2)}`,
      `Xero unpaid: S$${xeroTotal.toFixed(2)}`,
      `Matched unpaid: ${comparison.matched.length}`,
      `Already paid (not included): ${paid}`,
      `Missing from Xero: ${missing}`,
      `Amount differences: ${comparison.amountMismatch.length || none}`,
      `In Xero but not on the statement: ${absent}`,
      "",
      "*To pay*",
      ...(payableList.items.length
        ? payableList.items.map((item) => `• ${item.invoiceNumber}  S$${item.amount.toFixed(2)}`)
        : ["• Nothing to pay"]),
      `*Total: S$${payableList.totalAmount.toFixed(2)}*`,
      "",
      payableList.items.length
        ? "I'll prepare this payment in DBS next."
        : "No DBS payment needed.",
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
    if (payableList.items.length === 0) {
      return;
    }
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
          "I couldn't read that period. Please use one of the formats below."
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
            `Please send the statement of account for ${payload.periodLabel}. Thank you.`
          );
        }
        await whatsappService.sendText(
          payload.notifyPhone,
          `Asked *${supplier.name}* for the statement of account. I'll continue when it arrives.`
        );
        await this.finish(workflowRunId, WorkflowStatus.COMPLETED);
        return;
      }
      if (
        lower.includes("email") ||
        lower.includes("imap") ||
        lower.includes("inbox") ||
        lower.includes("both") ||
        lower === "soa"
      ) {
        payload.sourceChoice = "email";
      } else {
        payload.sourceChoice = "xero";
      }
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
