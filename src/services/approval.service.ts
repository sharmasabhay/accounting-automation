import { ApprovalGateType, ApprovalStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { whatsappService } from "./whatsapp.service.js";
import { auditService } from "./audit.service.js";
import { organizationService } from "./organization.service.js";
import { getOrganizationId } from "../context/tenant.js";

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

    await whatsappService.sendText(
      supervisorPhone,
      `🔔 Approval required (${input.gateType}):\n${input.question}\n\nReply: ${(input.options ?? ["Yes", "No"]).join(" / ")}`
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
}

export const approvalService = new ApprovalService();
