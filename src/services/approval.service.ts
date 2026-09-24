import { ApprovalGateType, ApprovalStatus, WorkflowStatus, WorkflowType } from "@prisma/client";
import { prisma } from "../db/client.js";
import { whatsappService } from "./whatsapp.service.js";
import { auditService } from "./audit.service.js";
import { organizationService } from "./organization.service.js";
import { followUpService } from "./follow-up.service.js";
import { getOrganizationId } from "../context/tenant.js";
import { logWaiting } from "../utils/workflow-log.js";

export interface CreateApprovalInput {
  workflowRunId: string;
  gateType: ApprovalGateType;
  question: string;
  options?: string[];
}

class ApprovalService {
  async create(input: CreateApprovalInput) {
    const organizationId = getOrganizationId();

    const approval = await prisma.approvalRequest.create({
      data: {
        workflowRunId: input.workflowRunId,
        gateType: input.gateType,
        question: input.question,
        options: input.options ?? ["Yes", "No"],
      },
    });

    const supervisorPhone =
      (await organizationService.getSupervisorPhone(organizationId)) ?? "+6590000000";

    const options = input.options ?? ["Yes", "No"];
    const compactOptions = options.every((option) => option.length <= 16);
    const footer = /reply/i.test(input.question)
      ? "Or reply *restart* to cancel."
      : compactOptions
        ? `Reply ${options.map((option) => `*${option}*`).join(" / ")}. Or *restart* to cancel.`
        : "Or reply *restart* to cancel.";
    await whatsappService.sendText(supervisorPhone, `${input.question}\n\n${footer}`);
    logWaiting(
      input.workflowRunId,
      `Reply in Admin → Activity → Supervisor chat`
    );

    await auditService.log({
      workflowRunId: input.workflowRunId,
      organizationId,
      triggerEvent: "approval.created",
      actor: "approval.service",
      sourceChannel: "system",
      inputs: { gateType: input.gateType, question: input.question },
      outcome: "pending",
    });

    await followUpService.schedule({
      workflowRunId: input.workflowRunId,
      organizationId,
      targetPhone: supervisorPhone,
      message: `Still waiting on: ${input.question}`,
    });

    return approval;
  }

  async resolve(approvalId: string, response: string, respondedBy: string) {
    const approval = await prisma.approvalRequest.update({
      where: { id: approvalId },
      data: {
        status:
          response.toLowerCase() === "yes" || response.toLowerCase() === "approve"
            ? ApprovalStatus.APPROVED
            : ApprovalStatus.REJECTED,
        response,
        respondedBy,
        resolvedAt: new Date(),
      },
      include: { workflowRun: true },
    });

    await followUpService.cancelForWorkflow(approval.workflowRunId);

    await auditService.log({
      workflowRunId: approval.workflowRunId,
      organizationId: approval.workflowRun.organizationId,
      triggerEvent: "approval.resolved",
      actor: "approval.service",
      sourceChannel: "whatsapp",
      inputs: { approvalId, response, respondedBy },
      outcome: approval.status,
    });

    return approval;
  }

  async findPendingByWorkflow(workflowRunId: string) {
    return prisma.approvalRequest.findFirst({
      where: { workflowRunId, status: ApprovalStatus.PENDING },
      orderBy: { createdAt: "desc" },
    });
  }

  async findPendingForOrganization(organizationId: string) {
    return prisma.approvalRequest.findFirst({
      where: {
        status: ApprovalStatus.PENDING,
        workflowRun: { organizationId },
      },
      orderBy: { createdAt: "desc" },
      include: { workflowRun: true },
    });
  }

  async abandonPending(
    approval: { id: string; workflowRunId: string },
    reason: string
  ): Promise<void> {
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: {
        status: ApprovalStatus.EXPIRED,
        response: reason,
        resolvedAt: new Date(),
      },
    });
    await prisma.workflowRun.update({
      where: { id: approval.workflowRunId },
      data: {
        status: WorkflowStatus.CANCELLED,
        error: reason,
        completedAt: new Date(),
      },
    });
    const run = await prisma.workflowRun.findUnique({
      where: { id: approval.workflowRunId },
      select: { type: true, result: true },
    });
    if (run?.type === WorkflowType.PAYMENT_EXECUTION) {
      const batchId = (run.result as { paymentBatchId?: string } | null)?.paymentBatchId;
      if (batchId) {
        await prisma.paymentBatch.updateMany({
          where: { id: batchId, status: "STANDBY_REQUESTED" },
          data: { status: "FAILED", error: reason },
        });
      }
    }
    await followUpService.cancelForWorkflow(approval.workflowRunId);
  }

  async supersedePendingInvoiceCaptures(
    organizationId: string,
    exceptRunId?: string
  ): Promise<number> {
    const pending = await prisma.approvalRequest.findMany({
      where: {
        status: ApprovalStatus.PENDING,
        workflowRun: {
          organizationId,
          type: WorkflowType.INVOICE_CAPTURE,
          ...(exceptRunId ? { id: { not: exceptRunId } } : {}),
        },
      },
    });

    if (!pending.length) return 0;

    const runIds = [...new Set(pending.map((row) => row.workflowRunId))];
    await prisma.approvalRequest.updateMany({
      where: { id: { in: pending.map((row) => row.id) } },
      data: {
        status: ApprovalStatus.EXPIRED,
        response: "superseded",
        resolvedAt: new Date(),
      },
    });
    await prisma.workflowRun.updateMany({
      where: { id: { in: runIds } },
      data: {
        status: WorkflowStatus.CANCELLED,
        error: "Superseded by a new invoice upload",
        completedAt: new Date(),
      },
    });
    for (const runId of runIds) {
      await followUpService.cancelForWorkflow(runId);
    }

    const supervisorPhone =
      (await organizationService.getSupervisorPhone(organizationId)) ?? "+6590000000";
    await whatsappService.sendText(
      supervisorPhone,
      "Cancelled the previous invoice wait so I can process the file you just uploaded."
    );
    return pending.length;
  }
}

export const approvalService = new ApprovalService();
