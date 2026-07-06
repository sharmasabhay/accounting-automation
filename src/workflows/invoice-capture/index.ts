import { WorkflowStatus, ApprovalGateType } from "@prisma/client";
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
import type { WhatsAppInboundMessage } from "../../types/index.js";

const CONFIDENCE_THRESHOLD = 0.75;

export const invoiceCaptureWorkflow = {
  async startFromWhatsApp(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    const isAuthorized = await authorizationService.isTeamMember(message.from);
    if (!isAuthorized) {
      await whatsappService.sendText(message.from, "Unauthorized upload.");
      return;
    }

    if (!message.mediaId) {
      await whatsappService.sendText(message.from, "No attachment found.");
      return;
    }

    const buffer = await whatsappService.downloadMedia(message.mediaId);
    const filePath = await saveUploadedFile(buffer, message.filename ?? "invoice.jpg");
    await this.processInvoice(workflowRunId, filePath, "WHATSAPP", message.messageId, message.from);
  },

  async startFromEmailScan(workflowRunId: string): Promise<void> {
    const organizationId = getOrganizationId();
    const supervisorPhone =
      (await organizationService.getSupervisorPhone(organizationId)) ?? "+6590000000";
    const attachments = await emailService.scanInvoiceInbox();

    for (const attachment of attachments) {
      const isWhitelisted = await authorizationService.isWhitelistedEmailDomain(attachment.from);
      if (!isWhitelisted) continue;

      const filePath = await saveUploadedFile(attachment.content, attachment.filename);
      await this.processInvoice(
        workflowRunId,
        filePath,
        "EMAIL",
        attachment.messageId,
        supervisorPhone
      );
      await emailService.markEmailProcessed(attachment.messageId);
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
    notifyPhone: string
  ): Promise<void> {
    const { extraction, rawText } = await ocrService.extractFromFile(filePath);

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
    }

    const organizationId = getOrganizationId();

    const supplier = await prisma.supplier.findFirst({
      where: {
        organizationId,
        name: { contains: extraction.supplier.value, mode: "insensitive" },
      },
    });

    if (supplier) {
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
        return;
      }
    }

    const candidate = await prisma.invoiceCandidate.create({
      data: {
        supplierId: supplier?.id,
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

    // PO matching scaffold — in production, match against open POs
    const matchedPo = supplier
      ? await prisma.purchaseOrder.findFirst({
          where: { supplierId: supplier.id, status: "SUBMITTED" },
          orderBy: { createdAt: "desc" },
        })
      : null;

    if (!matchedPo) {
      await approvalService.create({
        workflowRunId,
        gateType: ApprovalGateType.CREATE_PO_FROM_INVOICE,
        question: `Invoice ${extraction.invoiceNumber.value} from ${extraction.supplier.value} for S$${extraction.total.value} doesn't match any open PO. Create new PO?`,
      });
      return;
    }

    const bill = await xeroService.convertPoToBill(organizationId, {
      purchaseOrderId: matchedPo.xeroPoId ?? undefined,
      supplierContactId: supplier!.xeroContactId ?? supplier!.id,
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
        supplierId: supplier!.id,
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
      `✅ Bill created: ${extraction.invoiceNumber.value} — S$${extraction.total.value} (${supplier!.name})`
    );

    await auditService.log({
      workflowRunId,
      triggerEvent: sourceRef,
      actor: "invoice-capture",
      sourceChannel: source === "EMAIL" ? "email" : "whatsapp-dm",
      inputs: { filePath, rawText: rawText.slice(0, 500) },
      outputs: { billId: bill.xeroBillId, candidateId: candidate.id },
      outcome: "success",
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
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: WorkflowStatus.COMPLETED, completedAt: new Date() },
    });
  },
};
