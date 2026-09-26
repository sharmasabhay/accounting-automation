import { WorkflowStatus, ApprovalGateType, Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getOrganizationId } from "../../context/tenant.js";
import { authorizationService } from "../../services/authorization.service.js";
import { ocrService } from "../../services/ocr.service.js";
import { xeroService } from "../../services/xero.service.js";
import { whatsappService } from "../../services/whatsapp.service.js";
import { approvalService } from "../../services/approval.service.js";
import { auditService } from "../../services/audit.service.js";
import { skuMappingService } from "../../services/sku-mapping.service.js";
import { saveUploadedFile } from "../../utils/storage.js";
import { logger } from "../../utils/logger.js";
import { logDone, logStep } from "../../utils/workflow-log.js";
import {
  isWithinDaysBefore,
  matchInvoiceToPo,
  namedPoFromInvoice,
  poNumbersMatch,
  selectInvoicePurchaseOrder,
  isAffirmativeReply,
  isNegativeReply,
  type InvoicePoCandidate,
} from "../../utils/matching.js";
import { hasCoreInvoiceFields } from "../../utils/invoice-parse.js";
import { isXeroError, notifySupervisorOfXeroError } from "../../utils/xero-error.js";
import type { InvoiceExtraction, WhatsAppInboundMessage } from "../../types/index.js";

const CONFIDENCE_THRESHOLD = 0.75;

const PARSE_FAIL_MESSAGE =
  "Sorry, I wasn't able to understand or parse that file. Please resend a clear invoice *photo* (JPEG or PNG) or PDF, or reply *help* for guidance.";

const PROCESS_FAIL_MESSAGE =
  "Sorry, I failed to process your upload due to a system error. Please try again in a moment, or resend a clear invoice photo (JPEG/PNG).";

interface InvoicePayload {
  filePath: string;
  source: "EMAIL" | "WHATSAPP";
  sourceRef: string;
  notifyPhone: string;
  mimeType?: string;
  extraction: InvoiceExtraction;
  candidateId?: string;
  supplierId?: string;
  matchedPoId?: string;
  forcedPoNumber?: string;
  poChoices?: Array<{ localId?: string; xeroPoId?: string; poNumber: string }>;
  requireOrderReceived?: boolean;
  pendingMappings?: Array<{ supplierItemName: string }>;
}

function isUnusableExtraction(extraction: InvoiceExtraction): boolean {
  return !hasCoreInvoiceFields(extraction);
}

export const invoiceCaptureWorkflow = {
  async startFromWhatsApp(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    const isAuthorized = await authorizationService.isTeamMember(message.from);
    if (!isAuthorized) {
      await whatsappService.sendText(message.from, "Unauthorized upload.");
      await this.failRun(workflowRunId, "Unauthorized upload");
      return;
    }

    if (!message.mediaId) {
      await whatsappService.sendText(message.from, "No attachment found.");
      await this.failRun(workflowRunId, "No attachment found");
      return;
    }

    try {
      const buffer = await whatsappService.downloadMedia(message.mediaId);
      const filePath = await saveUploadedFile(buffer, message.filename ?? "invoice.jpg");
      await this.processInvoice(
        workflowRunId,
        filePath,
        "WHATSAPP",
        message.messageId,
        message.from,
        message.mimeType
      );
    } catch (error) {
      await this.notifyFailure(message.from, error, workflowRunId, message.messageId);
    }
  },

  async processInvoice(
    workflowRunId: string,
    filePath: string,
    source: "EMAIL" | "WHATSAPP",
    sourceRef: string,
    notifyPhone: string,
    mimeType?: string,
    requireOrderReceived = false
  ): Promise<void> {
    await approvalService.supersedePendingInvoiceCaptures(getOrganizationId(), workflowRunId);

    let extraction: InvoiceExtraction;
    let rawText: string;

    try {
      ({ extraction, rawText } = await ocrService.extractFromFile(filePath, mimeType));
    } catch (error) {
      await this.notifyFailure(notifyPhone, error, workflowRunId, sourceRef);
      return;
    }

    if (isUnusableExtraction(extraction)) {
      await whatsappService.sendText(
        notifyPhone,
        `${PARSE_FAIL_MESSAGE}\n\nRead: ${extraction.supplier.value} · ${extraction.invoiceNumber.value} · S$${extraction.total.value}`
      );
      await this.failRun(workflowRunId, "Unusable invoice extraction", {
        supplier: extraction.supplier.value,
        invoiceNumber: extraction.invoiceNumber.value,
      });
      await auditService.log({
        workflowRunId,
        triggerEvent: sourceRef,
        actor: "invoice-capture",
        sourceChannel: source === "EMAIL" ? "email" : "whatsapp-dm",
        inputs: { filePath, rawText: rawText.slice(0, 500) },
        outcome: "parse_failed",
      });
      return;
    }

    const payload: InvoicePayload = {
      filePath,
      source,
      sourceRef,
      notifyPhone,
      mimeType,
      extraction,
      requireOrderReceived,
    };
    await this.savePayload(workflowRunId, payload);
    logStep(
      workflowRunId,
      "Invoice extracted",
      `${extraction.supplier.value} · ${extraction.invoiceNumber.value} · S$${extraction.total.value}`
    );
    await this.continueAfterExtraction(workflowRunId);
  },

  async continueAfterExtraction(workflowRunId: string): Promise<void> {
    const payload = await this.getPayload(workflowRunId);
    if (!payload) {
      await this.failRun(workflowRunId, "Missing invoice payload");
      return;
    }
    const { extraction, filePath, source, sourceRef, notifyPhone } = payload;

    const lowConfidenceFields = [
      extraction.supplier.confidence < CONFIDENCE_THRESHOLD ? "supplier" : null,
      extraction.invoiceNumber.confidence < CONFIDENCE_THRESHOLD ? "invoiceNumber" : null,
      extraction.total.confidence < CONFIDENCE_THRESHOLD ? "total" : null,
    ].filter(Boolean);

    if (lowConfidenceFields.length > 0) {
      await this.pause(
        workflowRunId,
        payload,
        ApprovalGateType.FIELD_CONFIRMATION,
        `Low confidence on: ${lowConfidenceFields.join(", ")}. Supplier: ${extraction.supplier.value}, Invoice#: ${extraction.invoiceNumber.value}, Total: S$${extraction.total.value}. Confirm?`,
        "2.4-field-confirmation"
      );
      return;
    }

    if (extraction.signedOrStamped === false) {
      await whatsappService.sendText(
        notifyPhone,
        `⚠️ Invoice ${extraction.invoiceNumber.value} has no visible signature or company chop. Continuing, but please double-check.`
      );
    }

    const organizationId = getOrganizationId();
    const supplier = payload.supplierId
      ? await prisma.supplier.findFirst({
          where: { id: payload.supplierId, organizationId, isActive: true },
        })
      : await this.resolveSupplier(organizationId, extraction.supplier.value);

    if (!supplier) {
      const activeSuppliers = await prisma.supplier.findMany({
        where: { organizationId, isActive: true },
        select: { name: true },
        orderBy: { name: "asc" },
      });
      const names = activeSuppliers.map((s) => s.name).join(", ") || "(none configured)";
      await this.pause(
        workflowRunId,
        payload,
        ApprovalGateType.SUPPLIER_CLARIFICATION,
        `Invoice supplier read as "${extraction.supplier.value}" (INV ${extraction.invoiceNumber.value}, S$${extraction.total.value}) but no matching supplier was found. Known suppliers: ${names}. Reply with the correct supplier name.`,
        "2.4-supplier-clarification",
        ["Reply with the supplier name"]
      );
      return;
    }

    payload.supplierId = supplier.id;

    try {
      const isDuplicate = await xeroService.findDuplicateBill(
        organizationId,
        supplier.xeroContactId ?? supplier.id,
        extraction.invoiceNumber.value
      );
      if (isDuplicate) {
        await whatsappService.sendText(
          notifyPhone,
          `Duplicate invoice skipped: ${extraction.invoiceNumber.value} from ${supplier.name}`
        );
        await this.failRun(workflowRunId, "Duplicate invoice");
        return;
      }

      const candidate =
        payload.candidateId
          ? await prisma.invoiceCandidate.findUnique({ where: { id: payload.candidateId } })
          : await prisma.invoiceCandidate.create({
              data: {
                supplierId: supplier.id,
                source,
                sourceRef,
                filePath,
                extraction: extraction as object,
                confidence: {
                  supplier: extraction.supplier.confidence,
                  invoiceNumber: extraction.invoiceNumber.confidence,
                  total: extraction.total.confidence,
                },
                invoiceNumber: extraction.invoiceNumber.value,
                invoiceDate: new Date(extraction.invoiceDate.value),
                totalAmount: extraction.total.value,
              },
            });
      if (!candidate) {
        await this.failRun(workflowRunId, "Invoice candidate missing");
        return;
      }
      payload.candidateId = candidate.id;

      const waiting = await prisma.reconciliationRun.findFirst({
        where: { supplierId: supplier.id, status: "AWAITING_MISSING_INVOICES" },
        orderBy: { createdAt: "desc" },
      });
      const waitingNumbers = ((waiting?.summary as { missing?: string[] } | null)?.missing ?? []).map(
        (value) => value.toLowerCase()
      );
      if (
        waiting &&
        waitingNumbers.includes(extraction.invoiceNumber.value.toLowerCase()) &&
        !payload.requireOrderReceived
      ) {
        await this.pause(
          workflowRunId,
          payload,
          ApprovalGateType.ORDER_RECEIVED_CONFIRMATION,
          `SOA listed invoice ${extraction.invoiceNumber.value} from ${supplier.name} which was missing in Xero. Confirm the goods/order were actually received before I create the bill?`,
          "2.9-order-received"
        );
        return;
      }

      for (const line of extraction.lineItems) {
        const mapped = await skuMappingService.find(supplier.id, line.name.value);
        if (mapped) {
          line.name.value = mapped.xeroItemCode ?? mapped.supplierItemName;
          continue;
        }
        const resolved = await skuMappingService.resolveItem(
          organizationId,
          supplier.id,
          line.name.value
        );
        if (resolved.needsConfirmation) {
          payload.pendingMappings = [{ supplierItemName: line.name.value }];
          await this.pause(
            workflowRunId,
            payload,
            ApprovalGateType.SKU_MAPPING_CONFIRMATION,
            `New supplier item "${line.name.value}" from ${supplier.name}. Reply with the internal SKU/Xero item code to remember it.`,
            "2.5-sku-mapping",
            ["item code"]
          );
          return;
        }
      }

      const invoiceDate = new Date(extraction.invoiceDate.value);
      const openPos = await xeroService.getOpenPurchaseOrders(
        organizationId,
        supplier.xeroContactId ?? supplier.id,
        invoiceDate
      );
      const localPos = await prisma.purchaseOrder.findMany({
        where: {
          supplierId: supplier.id,
          status: { in: ["SUBMITTED", "AUTHORISED"] },
          bills: { none: {} },
        },
        include: { lines: true },
        orderBy: { createdAt: "desc" },
      });

      const candidates: InvoicePoCandidate[] = [];
      for (const po of localPos) {
        if (!isWithinDaysBefore(po.createdAt, invoiceDate)) continue;
        candidates.push({
          localId: po.id,
          xeroPoId: po.xeroPoId ?? undefined,
          poNumber: po.xeroPoNumber ?? po.id,
          total: Number(po.totalAmount ?? 0),
          lines: po.lines.map((line) => ({
            name: line.itemName,
            quantity: Number(line.quantity),
            unitAmount: Number(line.unitPrice ?? 0),
          })),
        });
      }
      for (const xero of openPos) {
        if (
          candidates.some(
            (candidate) =>
              (xero.xeroPoId && candidate.xeroPoId === xero.xeroPoId) ||
              poNumbersMatch(candidate.poNumber, xero.xeroPoNumber)
          )
        ) {
          continue;
        }
        candidates.push({
          xeroPoId: xero.xeroPoId,
          poNumber: xero.xeroPoNumber,
          total: xero.total,
          lines: xero.lineItems.map((line) => ({
            name: line.description,
            quantity: line.quantity,
            unitAmount: line.unitAmount,
          })),
        });
      }

      const invoiceLines = extraction.lineItems.map((line) => ({
        name: line.name.value,
        quantity: line.quantity.value,
        unitAmount: line.unitAmount.value,
      }));
      const forced =
        (payload.forcedPoNumber
          ? candidates.find((candidate) => poNumbersMatch(candidate.poNumber, payload.forcedPoNumber!))
          : undefined) ??
        (payload.matchedPoId
          ? candidates.find((candidate) => candidate.localId === payload.matchedPoId)
          : undefined);
      const namedPoNumber = namedPoFromInvoice(
        extraction.invoiceNumber.value,
        extraction.poNumber?.value
      );
      const selection = forced
        ? (() => {
            const match = matchInvoiceToPo(invoiceLines, forced.lines, extraction.total.value, forced.total);
            return match.ok
              ? ({ status: "matched" as const, candidate: forced, match })
              : ({ status: "named-mismatch" as const, candidate: forced, match });
          })()
        : selectInvoicePurchaseOrder(invoiceLines, extraction.total.value, candidates, namedPoNumber);

      if (selection.status === "none") {
        const openList = candidates.map((candidate) => candidate.poNumber).join(", ") || "none";
        await this.pause(
          workflowRunId,
          payload,
          ApprovalGateType.CREATE_PO_FROM_INVOICE,
          `Invoice ${extraction.invoiceNumber.value} from ${supplier.name} for S$${extraction.total.value} doesn't match any open PO (${openList}). Create new PO?`,
          "2.8-create-po-from-invoice"
        );
        return;
      }

      if (selection.status === "ambiguous") {
        payload.poChoices = selection.candidates.map((candidate) => ({
          localId: candidate.localId,
          xeroPoId: candidate.xeroPoId,
          poNumber: candidate.poNumber,
        }));
        const numbers = selection.candidates.map((candidate) => candidate.poNumber);
        await this.pause(
          workflowRunId,
          payload,
          ApprovalGateType.FIELD_CONFIRMATION,
          `Several open POs for ${supplier.name} match this invoice: ${numbers.join(", ")}. Reply with the PO number to use.`,
          "2.6-po-choice",
          numbers
        );
        return;
      }

      const matched = selection.candidate;
      payload.matchedPoId = matched.localId;
      payload.poChoices = undefined;

      if (selection.status === "named-mismatch") {
        const match = selection.match;
        await this.pause(
          workflowRunId,
          payload,
          ApprovalGateType.DISCREPANCY_RESOLUTION,
          [
            `Invoice ${extraction.invoiceNumber.value} does not match PO ${matched.poNumber}.`,
            match.quantityMismatch ? "Quantity mismatch (must be exact)." : "",
            match.amountMismatch
              ? `Amount mismatch: invoice S$${match.invoiceTotal.toFixed(2)} vs PO S$${match.poTotal.toFixed(2)} (tolerance S$0.10).`
              : "",
            match.unmatchedInvoiceLines.length
              ? `Unmatched invoice lines: ${match.unmatchedInvoiceLines.join(", ")}`
              : "",
            match.unmatchedPoLines.length
              ? `Unmatched PO lines: ${match.unmatchedPoLines.join(", ")}`
              : "",
            "Reply *yes* to create the bill anyway, or *no* to stop.",
          ]
            .filter(Boolean)
            .join("\n"),
          "2.7-discrepancy"
        );
        return;
      }

      logStep(workflowRunId, "Matched PO", matched.poNumber);
      await this.createBillFromPayload(workflowRunId, payload, {
        purchaseOrderId: matched.xeroPoId,
        localPoId: matched.localId,
        purchaseOrderNumber: matched.poNumber,
      });
    } catch (error) {
      await this.notifyFailure(notifyPhone, error, workflowRunId, sourceRef);
    }
  },

  async createBillFromPayload(
    workflowRunId: string,
    payload: InvoicePayload,
    po: { purchaseOrderId?: string; localPoId?: string; purchaseOrderNumber?: string }
  ): Promise<void> {
    try {
      await this.performCreateBill(workflowRunId, payload, po);
    } catch (error) {
      await this.notifyFailure(payload.notifyPhone, error, workflowRunId, payload.sourceRef);
    }
  },

  async performCreateBill(
    workflowRunId: string,
    payload: InvoicePayload,
    po: { purchaseOrderId?: string; localPoId?: string; purchaseOrderNumber?: string }
  ): Promise<void> {
    const organizationId = getOrganizationId();
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: payload.supplierId } });
    const { extraction } = payload;
    let lineItems = extraction.lineItems
      .map((li) => ({
        description: li.name.value.trim(),
        quantity: li.quantity.value,
        unitAmount: li.unitAmount.value,
      }))
      .filter((line) => line.description && line.quantity > 0 && line.unitAmount > 0);

    if (!lineItems.length && po.localPoId) {
      const localPo = await prisma.purchaseOrder.findUnique({
        where: { id: po.localPoId },
        include: { lines: true },
      });
      lineItems =
        localPo?.lines.map((line) => ({
          description: line.itemName,
          quantity: Number(line.quantity),
          unitAmount: Number(line.unitPrice ?? 0),
        })).filter((line) => line.description && line.quantity > 0) ?? [];
    }

    if (!lineItems.length) {
      throw new Error(
        "That invoice has no usable line items. Resend a clearer PDF, or create the bill from a PO that still has lines."
      );
    }

    const bill = await xeroService.convertPoToBill(organizationId, {
      purchaseOrderId: po.purchaseOrderId,
      purchaseOrderNumber: po.purchaseOrderNumber,
      supplierContactId: supplier.xeroContactId ?? supplier.id,
      contactName: supplier.name,
      invoiceNumber: extraction.invoiceNumber.value,
      invoiceDate: extraction.invoiceDate.value,
      lineItems,
      total: extraction.total.value,
      attachmentPath: payload.filePath,
    });

    await prisma.xeroBill.create({
      data: {
        supplierId: supplier.id,
        purchaseOrderId: po.localPoId,
        xeroBillId: bill.xeroBillId,
        invoiceNumber: extraction.invoiceNumber.value,
        invoiceDate: new Date(extraction.invoiceDate.value),
        totalAmount: extraction.total.value,
        status: "SUBMITTED",
      },
    });

    if (po.localPoId) {
      await prisma.purchaseOrder.update({
        where: { id: po.localPoId },
        data: { status: "BILLED" },
      });
    }

    if (payload.candidateId) {
      await prisma.invoiceCandidate.update({
        where: { id: payload.candidateId },
        data: { isProcessed: true },
      });
    }

    await whatsappService.sendText(
      payload.notifyPhone,
      `✅ Bill created: ${extraction.invoiceNumber.value} — S$${extraction.total.value} (${supplier.name})`
    );
    logDone(
      workflowRunId,
      "Bill created",
      `${extraction.invoiceNumber.value} · S$${extraction.total.value} · ${supplier.name}`
    );

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: WorkflowStatus.COMPLETED, completedAt: new Date() },
    });

    await auditService.log({
      workflowRunId,
      triggerEvent: payload.sourceRef,
      actor: "invoice-capture",
      sourceChannel: payload.source === "EMAIL" ? "email" : "whatsapp-dm",
      inputs: { filePath: payload.filePath, extractedSupplier: extraction.supplier.value },
      outputs: { billId: bill.xeroBillId, candidateId: payload.candidateId, matchedSupplier: supplier.name },
      outcome: "success",
    });
  },

  async resolveSupplier(organizationId: string, extractedName: string) {
    const needle = extractedName.trim().toLowerCase();
    if (!needle || needle === "unknown") return null;

    const suppliers = await prisma.supplier.findMany({
      where: { organizationId, isActive: true },
    });

    const exact = suppliers.find((s) => s.name.toLowerCase() === needle);
    if (exact) return exact;

    const partial = suppliers.filter(
      (s) => s.name.toLowerCase().includes(needle) || needle.includes(s.name.toLowerCase())
    );
    if (partial.length === 1) return partial[0]!;
    return null;
  },

  async notifyFailure(
    to: string,
    error: unknown,
    workflowRunId: string,
    triggerEvent?: string
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const isParseIssue =
      /unsupported|parse|understand|unreadable|invalid image|file type/i.test(message);

    logger.error({ err: error, workflowRunId }, "Invoice capture failed");

    try {
      if (isXeroError(error)) {
        await notifySupervisorOfXeroError("process this invoice", error, to);
      } else {
        await whatsappService.sendText(
          to,
          isParseIssue
            ? `${PARSE_FAIL_MESSAGE}\n\nTechnical details: ${message}`
            : `${PROCESS_FAIL_MESSAGE}\n\nTechnical details: ${message}`
        );
      }
    } catch (notifyError) {
      logger.error({ notifyError }, "Failed to notify sender about invoice capture error");
    }

    await this.failRun(workflowRunId, message);

    if (triggerEvent) {
      await auditService.log({
        workflowRunId,
        triggerEvent,
        actor: "invoice-capture",
        sourceChannel: "whatsapp-dm",
        inputs: { error: message },
        outcome: "error",
      });
    }
  },

  async failRun(
    workflowRunId: string,
    error: string,
    extra?: Prisma.InputJsonObject
  ): Promise<void> {
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        status: WorkflowStatus.FAILED,
        error,
        completedAt: new Date(),
        ...(extra ? { result: extra } : {}),
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
      await this.failRun(workflowRunId, "Missing payload on approval");
      return;
    }

    if (gateType === ApprovalGateType.FIELD_CONFIRMATION) {
      if (payload.poChoices?.length) {
        if (isNegativeReply(response)) {
          await this.failRun(workflowRunId, "PO choice declined");
          return;
        }
        const picked = payload.poChoices.find((choice) => poNumbersMatch(choice.poNumber, response.trim()));
        if (!picked) {
          const numbers = payload.poChoices.map((choice) => choice.poNumber);
          await this.pause(
            workflowRunId,
            payload,
            ApprovalGateType.FIELD_CONFIRMATION,
            `Could not match "${response}" to an open PO. Reply with one of: ${numbers.join(", ")}.`,
            "2.6-po-choice",
            numbers
          );
          return;
        }
        payload.matchedPoId = picked.localId;
        payload.forcedPoNumber = picked.poNumber;
        payload.poChoices = undefined;
        await this.savePayload(workflowRunId, payload);
        await this.continueAfterExtraction(workflowRunId);
        return;
      }
      if (isNegativeReply(response)) {
        await this.failRun(workflowRunId, "Field confirmation rejected");
        return;
      }
      if (!isAffirmativeReply(response)) {
        const invoiceUnknown =
          payload.extraction.invoiceNumber.value.trim().toLowerCase() === "unknown" ||
          payload.extraction.invoiceNumber.confidence < CONFIDENCE_THRESHOLD;
        if (invoiceUnknown) {
          payload.extraction.invoiceNumber.value = response.trim();
        }
      }
      payload.extraction.supplier.confidence = 1;
      payload.extraction.invoiceNumber.confidence = 1;
      payload.extraction.total.confidence = 1;
      await this.savePayload(workflowRunId, payload);
      await this.continueAfterExtraction(workflowRunId);
      return;
    }

    if (gateType === ApprovalGateType.SUPPLIER_CLARIFICATION) {
      const supplier = await this.resolveSupplier(getOrganizationId(), response);
      if (!supplier) {
        await whatsappService.sendText(
          payload.notifyPhone,
          `Could not match "${response}" to a supplier. Try again with the supplier name.`
        );
        await this.pause(
          workflowRunId,
          payload,
          ApprovalGateType.SUPPLIER_CLARIFICATION,
          `Still no match for "${response}". Reply with a known supplier name.`,
          "2.4-supplier-clarification",
          ["Reply with the supplier name"]
        );
        return;
      }
      payload.supplierId = supplier.id;
      await this.savePayload(workflowRunId, payload);
      await this.continueAfterExtraction(workflowRunId);
      return;
    }

    if (gateType === ApprovalGateType.SKU_MAPPING_CONFIRMATION) {
      const pending = payload.pendingMappings?.[0];
      if (pending && payload.supplierId) {
        await skuMappingService.confirm({
          supplierId: payload.supplierId,
          supplierItemName: pending.supplierItemName,
          xeroItemId: response.trim(),
          xeroItemCode: response.trim(),
          confirmedBy: "supervisor",
        });
      }
      payload.pendingMappings = [];
      await this.savePayload(workflowRunId, payload);
      await this.continueAfterExtraction(workflowRunId);
      return;
    }

    if (gateType === ApprovalGateType.CREATE_PO_FROM_INVOICE) {
      if (!isAffirmativeReply(response)) {
        await this.failRun(workflowRunId, "Retrospective PO declined");
        return;
      }
      try {
        const organizationId = getOrganizationId();
        const supplier = await prisma.supplier.findUniqueOrThrow({
          where: { id: payload.supplierId },
        });
        const created = await xeroService.createPurchaseOrder(organizationId, {
          supplierContactId: supplier.xeroContactId ?? supplier.id,
          contactName: supplier.name,
          lineItems: payload.extraction.lineItems.map((line) => ({
            description: line.name.value,
            quantity: line.quantity.value,
            unitAmount: line.unitAmount.value,
          })),
        });
        const local = await prisma.purchaseOrder.create({
          data: {
            supplierId: supplier.id,
            xeroPoId: created.xeroPoId,
            xeroPoNumber: created.xeroPoNumber,
            status: "SUBMITTED",
            totalAmount: payload.extraction.total.value,
            lines: {
              create: payload.extraction.lineItems.map((line) => ({
                itemName: line.name.value,
                quantity: line.quantity.value,
                unitPrice: line.unitAmount.value,
                lineAmount: line.quantity.value * line.unitAmount.value,
              })),
            },
          },
        });
        await this.createBillFromPayload(workflowRunId, payload, {
          purchaseOrderId: created.xeroPoId,
          localPoId: local.id,
          purchaseOrderNumber: created.xeroPoNumber,
        });
      } catch (error) {
        await this.notifyFailure(payload.notifyPhone, error, workflowRunId, payload.sourceRef);
      }
      return;
    }

    if (gateType === ApprovalGateType.DISCREPANCY_RESOLUTION) {
      if (!isAffirmativeReply(response)) {
        await this.failRun(workflowRunId, "Discrepancy not approved");
        return;
      }
      const po = payload.matchedPoId
        ? await prisma.purchaseOrder.findUnique({ where: { id: payload.matchedPoId } })
        : null;
      await this.createBillFromPayload(workflowRunId, payload, {
        purchaseOrderId: po?.xeroPoId ?? undefined,
        localPoId: po?.id,
        purchaseOrderNumber: po?.xeroPoNumber ?? undefined,
      });
      return;
    }

    if (gateType === ApprovalGateType.ORDER_RECEIVED_CONFIRMATION) {
      if (!isAffirmativeReply(response)) {
        await this.failRun(workflowRunId, "Goods received not confirmed");
        return;
      }
      payload.requireOrderReceived = true;
      await this.savePayload(workflowRunId, payload);
      await this.continueAfterExtraction(workflowRunId);
    }
  },

  async pause(
    workflowRunId: string,
    payload: InvoicePayload,
    gateType: ApprovalGateType,
    question: string,
    currentStep: string,
    options?: string[]
  ): Promise<void> {
    await this.savePayload(workflowRunId, payload, currentStep, WorkflowStatus.AWAITING_APPROVAL);
    await approvalService.create({ workflowRunId, gateType, question, options });
  },

  async savePayload(
    workflowRunId: string,
    payload: InvoicePayload,
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

  async getPayload(workflowRunId: string): Promise<InvoicePayload | null> {
    const run = await prisma.workflowRun.findUnique({ where: { id: workflowRunId } });
    return (run?.payload as InvoicePayload | null) ?? null;
  },
};
