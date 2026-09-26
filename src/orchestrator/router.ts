import { WorkflowType, WorkflowStatus, ApprovalGateType } from "@prisma/client";
import { prisma } from "../db/client.js";
import { auditService } from "../services/audit.service.js";
import { organizationService } from "../services/organization.service.js";
import { authorizationService } from "../services/authorization.service.js";
import { emailService } from "../services/email.service.js";
import { followUpService } from "../services/follow-up.service.js";
import { conversationService } from "../services/conversation.service.js";
import { poIntakeWorkflow } from "../workflows/po-intake/index.js";
import { invoiceCaptureWorkflow } from "../workflows/invoice-capture/index.js";
import { reconciliationWorkflow } from "../workflows/reconciliation/index.js";
import { paymentExecutionWorkflow } from "../workflows/payment-execution/index.js";
import { progressService } from "../services/progress.service.js";
import { withOrganization } from "../context/tenant.js";
import { saveUploadedFile } from "../utils/storage.js";
import { isSoaDocument, isReadyReply } from "../utils/matching.js";
import type { WorkflowEvent, WhatsAppInboundMessage, SavedEmailAttachment } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { logStep } from "../utils/workflow-log.js";
import { reportBackendError } from "../utils/error-alert.js";

class Orchestrator {
  async handleEvent(event: WorkflowEvent): Promise<void> {
    try {
      await this.dispatch(event);
    } catch (error) {
      await reportBackendError({
        source: "workflow",
        error,
        context: { eventType: event.type, payload: event.payload },
      });
      throw error;
    }
  }

  private async dispatch(event: WorkflowEvent): Promise<void> {
    logger.info({ eventType: event.type }, "Orchestrator received event");
    if (event.type === "whatsapp.message") {
      const text = event.payload.text?.slice(0, 120) ?? `(${event.payload.type})`;
      logStep(
        undefined,
        event.payload.isGroup ? "Group WhatsApp" : "WhatsApp DM",
        `${event.payload.from}: ${text}`
      );
    }

    switch (event.type) {
      case "whatsapp.message":
        await this.handleWhatsAppMessage(event.payload);
        break;
      case "email.scan":
        await withOrganization(event.payload.organizationId, async () => {
          const phone = (await organizationService.getSupervisorPhone(event.payload.organizationId)) ?? "";
          await progressService.whileWorking(phone, "the email inbox scan", () =>
            this.runEmailScan(event.payload.attachments)
          );
        });
        break;
      case "invoice.capture":
        await withOrganization(event.payload.organizationId, () =>
          progressService.whileWorking(event.payload.notifyPhone, "this invoice", () =>
            invoiceCaptureWorkflow.processInvoice(
              event.payload.workflowRunId,
              event.payload.filePath,
              event.payload.source,
              event.payload.sourceRef,
              event.payload.notifyPhone,
              event.payload.mimeType
            )
          )
        );
        break;
      case "approval.resolved":
        await withOrganization(event.payload.organizationId, () =>
          this.handleApprovalResolved(event.payload.approvalId, event.payload.response)
        );
        break;
      case "reconciliation.payable.ready":
        await withOrganization(event.payload.organizationId, () =>
          paymentExecutionWorkflow.start(event.payload.reconciliationRunId)
        );
        break;
      case "payment.monitor":
        await withOrganization(event.payload.organizationId, () =>
          paymentExecutionWorkflow.monitorApprovals()
        );
        break;
      case "follow-up":
        await withOrganization(event.payload.organizationId, () =>
          followUpService.handleDue(event.payload.taskId)
        );
        break;
    }
  }

  private async handleWhatsAppMessage(message: WhatsAppInboundMessage): Promise<void> {
    const organization = await organizationService.resolveFromWhatsApp(message);

    if (!organization) {
      logger.warn({ from: message.from }, "Could not resolve organization for WhatsApp message");
      return;
    }

    message.organizationId = organization.id;

    await withOrganization(
      organization.id,
      async () => {
        if (message.isGroup && !message.mentionsBot) {
          return;
        }
        const phone =
          message.isGroup
            ? ((await organizationService.getSupervisorPhone(organization.id)) ?? message.from)
            : message.from;
        await progressService.whileWorking(phone, describeWhatsAppWork(message), () =>
          this.routeWhatsAppMessage(message)
        );
      },
      organization.slug
    );
  }

  private async routeWhatsAppMessage(message: WhatsAppInboundMessage): Promise<void> {
    const text = message.text?.toLowerCase() ?? "";

    if (message.isGroup) {
      if (!message.mentionsBot) return;

      if (text.includes("reconcile") || text.includes("statement")) {
        const run = await this.createRun(WorkflowType.RECONCILIATION, message.messageId);
        await reconciliationWorkflow.startFromGroup(run.id, message);
        return;
      }

      if (text.includes("remove") || text.includes("modify") || text.includes("change") || text.includes("add")) {
        const run = await this.createRun(WorkflowType.PO_INTAKE, message.messageId);
        await poIntakeWorkflow.handleModification(run.id, message);
        return;
      }
      return;
    }

    if (text.includes("reconcile") || text.includes("payment") || text.includes("statement")) {
      const run = await this.createRun(WorkflowType.RECONCILIATION, message.messageId);
      await reconciliationWorkflow.startFromDm(run.id, message);
      return;
    }

    if (message.type === "image" || message.type === "document") {
      const run = await this.createRun(WorkflowType.INVOICE_CAPTURE, message.messageId);
      await invoiceCaptureWorkflow.startFromWhatsApp(run.id, message);
      return;
    }

    const run = await this.createRun(WorkflowType.PO_INTAKE, message.messageId);
    await poIntakeWorkflow.start(run.id, message);
  }

  async scanEmailInboxNow(organizationId: string) {
    return withOrganization(organizationId, async () => {
      const phone = (await organizationService.getSupervisorPhone(organizationId)) ?? "";
      return progressService.whileWorking(phone, "the email inbox scan", () => this.runEmailScan());
    });
  }

  private async runEmailScan(savedAttachments?: SavedEmailAttachment[]): Promise<{
    attachments: number;
    invoices: number;
    soa: number;
    skipped: Array<{ from: string; filename: string; reason: string }>;
  }> {
    const organizationId = (await import("../context/tenant.js")).getOrganizationId();
    const attachments = savedAttachments?.length
      ? await emailService.loadSavedAttachments(savedAttachments)
      : await emailService.scanInvoiceInbox({ throwOnError: true });
    const processed = new Map<string, number | undefined>();
    const skipped: Array<{ from: string; filename: string; reason: string }> = [];
    let invoices = 0;
    let soa = 0;

    for (const attachment of attachments) {
      const isSoa = attachment.kind === "soa" || isSoaDocument(attachment.filename, attachment.subject);

      if (isSoa) {
        soa += 1;
        const run = await this.createRun(
          WorkflowType.RECONCILIATION,
          `${attachment.messageId}:${attachment.filename}`
        );
        await reconciliationWorkflow.startFromSoaDocument(run.id, attachment);
      } else {
        const isWhitelisted = await authorizationService.isWhitelistedEmailDomain(attachment.from);
        if (!isWhitelisted) {
          const reason = `Sender ${attachment.from} is not a known supplier email domain`;
          logger.warn(
            { from: attachment.from, filename: attachment.filename },
            "Skipping email invoice — sender domain is not on a supplier"
          );
          skipped.push({ from: attachment.from, filename: attachment.filename, reason });
          continue;
        }

        const supervisorPhone =
          (await organizationService.getSupervisorPhone(organizationId)) ?? "+6590000000";
        const filePath =
          attachment.savedPath ?? (await saveUploadedFile(attachment.content, attachment.filename));
        await conversationService.recordInbound(organizationId, {
          messageId: `${attachment.messageId}:${attachment.filename}`,
          from: supervisorPhone,
          timestamp: String(Date.now()),
          type: attachment.contentType === "application/pdf" ? "document" : "image",
          filename: attachment.filename,
          mimeType: attachment.contentType,
          text: `[email invoice: ${attachment.filename} from ${attachment.from}]`,
          isGroup: false,
          organizationId,
        });
        const run = await this.createRun(
          WorkflowType.INVOICE_CAPTURE,
          `${attachment.messageId}:${attachment.filename}`
        );
        await invoiceCaptureWorkflow.processInvoice(
          run.id,
          filePath,
          "EMAIL",
          attachment.messageId,
          supervisorPhone,
          attachment.contentType
        );
        invoices += 1;
      }

      processed.set(attachment.messageId, attachment.uid);
    }

    for (const [messageId, uid] of processed) {
      await emailService.markEmailProcessed(messageId, uid);
    }

    logger.info(
      { organizationId, attachments: attachments.length, invoices, soa, skipped: skipped.length },
      "Email inbox scan finished"
    );

    return { attachments: attachments.length, invoices, soa, skipped };
  }

  private async handleApprovalResolved(approvalId: string, response: string): Promise<void> {
    const approval = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      include: { workflowRun: true },
    });
    if (!approval?.workflowRun) return;

    const { workflowRun } = approval;
    const phone = (await organizationService.getSupervisorPhone(workflowRun.organizationId)) ?? "";
    await progressService.whileWorking(
      phone,
      describeApprovalWork(workflowRun.type, approval.gateType, response),
      async () => {
        switch (workflowRun.type) {
          case WorkflowType.PO_INTAKE:
            await poIntakeWorkflow.onApprovalResolved(workflowRun.id, approval.gateType, response);
            break;
          case WorkflowType.INVOICE_CAPTURE:
            await invoiceCaptureWorkflow.onApprovalResolved(workflowRun.id, approval.gateType, response);
            break;
          case WorkflowType.RECONCILIATION:
            await reconciliationWorkflow.onApprovalResolved(workflowRun.id, approval.gateType, response);
            break;
          case WorkflowType.PAYMENT_EXECUTION:
            await paymentExecutionWorkflow.onApprovalResolved(workflowRun.id, approval.gateType, response);
            break;
        }
      }
    );
  }

  private async createRun(type: WorkflowType, triggerRef: string) {
    const { getOrganizationId } = await import("../context/tenant.js");
    const organizationId = getOrganizationId();

    const run = await prisma.workflowRun.create({
      data: { organizationId, type, triggerRef, status: WorkflowStatus.IN_PROGRESS },
    });

    await auditService.log({
      workflowRunId: run.id,
      organizationId,
      triggerEvent: triggerRef,
      actor: `orchestrator.${type.toLowerCase()}`,
      sourceChannel: "system",
      outcome: "started",
    });

    return run;
  }

  async runScheduledJob(
    jobName: "email.scan" | "payment.monitor",
    enqueue: (name: string, data: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    const organizations = await organizationService.listActiveOrganizations();

    for (const org of organizations) {
      await enqueue(jobName, {
        scheduledAt: new Date().toISOString(),
        organizationId: org.id,
      });
    }
  }
}

export const orchestrator = new Orchestrator();

function describeWhatsAppWork(message: WhatsAppInboundMessage): string {
  const text = message.text?.toLowerCase() ?? "";
  if (message.type === "image" || message.type === "document") return "this invoice";
  if (text.includes("reconcile") || text.includes("statement") || text.includes("payment")) {
    return "reconciliation";
  }
  if (text.includes("remove") || text.includes("modify") || text.includes("change") || text.includes("add")) {
    return "this order change";
  }
  return "your request";
}

function describeApprovalWork(type: WorkflowType, gateType: ApprovalGateType, response: string): string {
  if (gateType === ApprovalGateType.DBS_STANDBY || isReadyReply(response)) {
    return "the DBS payment";
  }
  if (type === WorkflowType.RECONCILIATION) return "reconciliation";
  if (type === WorkflowType.INVOICE_CAPTURE) return "this invoice";
  if (type === WorkflowType.PO_INTAKE) return "this order";
  return "your reply";
}
