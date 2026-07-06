import { WorkflowType, WorkflowStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { auditService } from "../services/audit.service.js";
import { organizationService } from "../services/organization.service.js";
import { poIntakeWorkflow } from "../workflows/po-intake/index.js";
import { invoiceCaptureWorkflow } from "../workflows/invoice-capture/index.js";
import { reconciliationWorkflow } from "../workflows/reconciliation/index.js";
import { paymentExecutionWorkflow } from "../workflows/payment-execution/index.js";
import { withOrganization } from "../context/tenant.js";
import type { WorkflowEvent, WhatsAppInboundMessage } from "../types/index.js";
import { logger } from "../utils/logger.js";

class Orchestrator {
  async handleEvent(event: WorkflowEvent): Promise<void> {
    logger.info({ eventType: event.type }, "Orchestrator received event");

    switch (event.type) {
      case "whatsapp.message":
        await this.handleWhatsAppMessage(event.payload);
        break;
      case "email.scan":
        await withOrganization(event.payload.organizationId, () =>
          this.runEmailScan()
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
    }
  }

  private async handleWhatsAppMessage(message: WhatsAppInboundMessage): Promise<void> {
    const organization = await organizationService.resolveFromWhatsApp(message);

    if (!organization) {
      logger.warn({ from: message.from }, "Could not resolve organization for WhatsApp message");
      return;
    }

    message.organizationId = organization.id;

    await withOrganization(organization.id, () => this.routeWhatsAppMessage(message), organization.slug);
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

      if (text.includes("remove") || text.includes("modify") || text.includes("change")) {
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

  private async runEmailScan(): Promise<void> {
    const run = await this.createRun(WorkflowType.INVOICE_CAPTURE, `email-scan-${Date.now()}`);
    await invoiceCaptureWorkflow.startFromEmailScan(run.id);
  }

  private async handleApprovalResolved(approvalId: string, response: string): Promise<void> {
    const approval = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      include: { workflowRun: true },
    });
    if (!approval?.workflowRun) return;

    const { workflowRun } = approval;

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

  /** Fan-out scheduled jobs across all active organizations. */
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
