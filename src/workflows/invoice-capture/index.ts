import { WorkflowStatus, ApprovalGateType, Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getOrganizationId } from "../../context/tenant.js";
import { authorizationService } from "../../services/authorization.service.js";
import { organizationService } from "../../services/organization.service.js";
import { ocrService } from "../../services/ocr.service.js";
import { xeroService } from "../../services/xero.service.js";
import { whatsappService } from "../../services/whatsapp.service.js";
import { approvalService } from "../../services/approval.service.js";
import { auditService } from "../../services/audit.service.js";
import { emailService } from "../../services/email.service.js";
import { saveUploadedFile } from "../../utils/storage.js";
import { logger } from "../../utils/logger.js";
import type { InvoiceExtraction, WhatsAppInboundMessage } from "../../types/index.js";

const CONFIDENCE_THRESHOLD = 0.75;

const PARSE_FAIL_MESSAGE =
  "Sorry, I wasn't able to understand or parse that file. Please resend a clear invoice *photo* (JPEG or PNG), or reply *help* for guidance.";

const PROCESS_FAIL_MESSAGE =
  "Sorry, I failed to process your upload due to a system error. Please try again in a moment, or resend a clear invoice photo (JPEG/PNG).";

function isUnusableExtraction(extraction: InvoiceExtraction): boolean {
  const supplier = extraction.supplier.value.trim().toLowerCase();
  const invoiceNumber = extraction.invoiceNumber.value.trim().toLowerCase();

  if (!supplier || supplier === "unknown") return true;
  if (!invoiceNumber || invoiceNumber === "unknown") return true;
  if (
    extraction.supplier.confidence < 0.4 &&
    extraction.invoiceNumber.confidence < 0.4 &&
    extraction.total.confidence < 0.4
  ) {
    return true;
  }
  return false;
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

  async startFromEmailScan(workflowRunId: string): Promise<void> {
    const organizationId = getOrganizationId();
    const supervisorPhone =
      (await organizationService.getSupervisorPhone(organizationId)) ?? "+6590000000";
    const attachments = await emailService.scanInvoiceInbox();

    for (const attachment of attachments) {
      const isWhitelisted = await authorizationService.isWhitelistedEmailDomain(attachment.from);
      if (!isWhitelisted) continue;

      try {
        const filePath = await saveUploadedFile(attachment.content, attachment.filename);
        await this.processInvoice(
          workflowRunId,
          filePath,
          "EMAIL",
          attachment.messageId,
          supervisorPhone,
          attachment.contentType
        );
        await emailService.markEmailProcessed(attachment.messageId);
      } catch (error) {
        await this.notifyFailure(supervisorPhone, error, workflowRunId, attachment.messageId);
      }
    }

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: WorkflowStatus.COMPLETED, completedAt: new Date() },
    });
  },

  async processInvoice(
    workflowRunId: string,
    filePath: string,
    source: "EMAIL" | "WHATSAPP",
    sourceRef: string,
    notifyPhone: string,
    mimeType?: string
  ): Promise<void> {
    let extraction: InvoiceExtraction;
    let rawText: string;

    try {
      ({ extraction, rawText } = await ocrService.extractFromFile(filePath, mimeType));
    } catch (error) {
      await this.notifyFailure(notifyPhone, error, workflowRunId, sourceRef);
      return;
    }

    if (isUnusableExtraction(extraction)) {
      await whatsappService.sendText(notifyPhone, PARSE_FAIL_MESSAGE);
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

    const lowConfidenceFields = [
      extraction.supplier.confidence < CONFIDENCE_THRESHOLD ? "supplier" : null,
      extraction.invoiceNumber.confidence < CONFIDENCE_THRESHOLD ? "invoiceNumber" : null,
      extraction.total.confidence < CONFIDENCE_THRESHOLD ? "total" : null,
    ].filter(Boolean);

    if (lowConfidenceFields.length > 0) {
      await approvalService.create({
        workflowRunId,
        gateType: ApprovalGateType.FIELD_CONFIRMATION,
        question: `Low confidence on: ${lowConfidenceFields.join(", ")}. Supplier: ${extraction.supplier.value}, Invoice#: ${extraction.invoiceNumber.value}, Total: S$${extraction.total.value}. Confirm?`,
      });
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: {
          status: WorkflowStatus.AWAITING_APPROVAL,
          currentStep: "2.4-field-confirmation",
          payload: { filePath, source, sourceRef, notifyPhone, extraction } as object,
        },
      });
      return;
    }

    const organizationId = getOrganizationId();
    const supplier = await this.resolveSupplier(organizationId, extraction.supplier.value);

    if (!supplier) {
      const activeSuppliers = await prisma.supplier.findMany({
        where: { organizationId, isActive: true },
        select: { name: true },
        orderBy: { name: "asc" },
      });
      const names = activeSuppliers.map((s) => s.name).join(", ") || "(none configured)";

      await approvalService.create({
        workflowRunId,
        gateType: ApprovalGateType.SUPPLIER_CLARIFICATION,
        question: `Invoice supplier read as "${extraction.supplier.value}" (INV ${extraction.invoiceNumber.value}, S$${extraction.total.value}) but no matching supplier was found. Known suppliers: ${names}. Reply with the correct supplier name.`,
        options: ["Reply with the supplier name"],
      });
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: {
          status: WorkflowStatus.AWAITING_APPROVAL,
          currentStep: "2.4-supplier-clarification",
          payload: { filePath, source, sourceRef, notifyPhone, extraction } as object,
        },
      });
      return;
    }

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

      const candidate = await prisma.invoiceCandidate.create({
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

      const matchedPo = await prisma.purchaseOrder.findFirst({
        where: { supplierId: supplier.id, status: "SUBMITTED" },
        orderBy: { createdAt: "desc" },
      });

      if (!matchedPo) {
        await approvalService.create({
          workflowRunId,
          gateType: ApprovalGateType.CREATE_PO_FROM_INVOICE,
          question: `Invoice ${extraction.invoiceNumber.value} from ${supplier.name} for S$${extraction.total.value} doesn't match any open PO. Create new PO?`,
        });
        await prisma.workflowRun.update({
          where: { id: workflowRunId },
          data: {
            status: WorkflowStatus.AWAITING_APPROVAL,
            currentStep: "2.8-create-po-from-invoice",
            payload: { candidateId: candidate.id, supplierId: supplier.id } as object,
          },
        });
        return;
      }

      const bill = await xeroService.convertPoToBill(organizationId, {
        purchaseOrderId: matchedPo.xeroPoId ?? undefined,
        supplierContactId: supplier.xeroContactId ?? supplier.id,
        invoiceNumber: extraction.invoiceNumber.value,
        invoiceDate: extraction.invoiceDate.value,
        lineItems: extraction.lineItems.map((li) => ({
          description: li.name.value,
          quantity: li.quantity.value,
          unitAmount: li.unitAmount.value,
        })),
        total: extraction.total.value,
      });

      await prisma.xeroBill.create({
        data: {
          supplierId: supplier.id,
          purchaseOrderId: matchedPo.id,
          xeroBillId: bill.xeroBillId,
          invoiceNumber: extraction.invoiceNumber.value,
          invoiceDate: new Date(extraction.invoiceDate.value),
          totalAmount: extraction.total.value,
          status: "SUBMITTED",
        },
      });

      await prisma.invoiceCandidate.update({
        where: { id: candidate.id },
        data: { isProcessed: true },
      });

      await whatsappService.sendText(
        notifyPhone,
        `✅ Bill created: ${extraction.invoiceNumber.value} — S$${extraction.total.value} (${supplier.name})`
      );

      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: WorkflowStatus.COMPLETED, completedAt: new Date() },
      });

      await auditService.log({
        workflowRunId,
        triggerEvent: sourceRef,
        actor: "invoice-capture",
        sourceChannel: source === "EMAIL" ? "email" : "whatsapp-dm",
        inputs: {
          filePath,
          rawText: rawText.slice(0, 500),
          extractedSupplier: extraction.supplier.value,
        },
        outputs: {
          billId: bill.xeroBillId,
          candidateId: candidate.id,
          matchedSupplier: supplier.name,
        },
        outcome: "success",
      });
    } catch (error) {
      await this.notifyFailure(notifyPhone, error, workflowRunId, sourceRef);
    }
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
      (s) =>
        s.name.toLowerCase().includes(needle) || needle.includes(s.name.toLowerCase())
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
      await whatsappService.sendText(
        to,
        isParseIssue
          ? `${PARSE_FAIL_MESSAGE}\n\nDetails: ${message}`
          : PROCESS_FAIL_MESSAGE
      );
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
    if (gateType === ApprovalGateType.CREATE_PO_FROM_INVOICE && response.toLowerCase() === "yes") {
      const supervisorPhone =
        (await organizationService.getSupervisorPhone(getOrganizationId())) ?? "+6590000000";
      await whatsappService.sendText(
        supervisorPhone,
        "Creating PO from invoice and converting to bill (scaffold)."
      );
    }

    if (gateType === ApprovalGateType.SUPPLIER_CLARIFICATION) {
      const supervisorPhone =
        (await organizationService.getSupervisorPhone(getOrganizationId())) ?? "+6590000000";
      const supplier = await this.resolveSupplier(getOrganizationId(), response);
      if (!supplier) {
        await whatsappService.sendText(
          supervisorPhone,
          `Could not match "${response}" to a supplier. Please edit the supplier name in Admin and resend the invoice.`
        );
      } else {
        await whatsappService.sendText(
          supervisorPhone,
          `Noted supplier as ${supplier.name}. Please resend the invoice photo so we can continue with the correct supplier.`
        );
      }
    }

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: WorkflowStatus.COMPLETED, completedAt: new Date() },
    });
  },
};
