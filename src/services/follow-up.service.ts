import { prisma } from "../db/client.js";
import { organizationService } from "./organization.service.js";
import { whatsappService } from "./whatsapp.service.js";
import { logger } from "../utils/logger.js";

async function enqueueFollowUp(taskId: string, organizationId: string, delayMs: number) {
  const { enqueueJob } = await import("../jobs/queue.js");
  await enqueueJob("follow-up", { taskId, organizationId }, { delay: delayMs });
}

class FollowUpService {
  async schedule(input: {
    workflowRunId: string;
    organizationId: string;
    targetPhone?: string;
    message: string;
    intervalMin?: number;
    maxAttempts?: number;
  }): Promise<void> {
    const intervalMin = input.intervalMin ?? 30;
    const targetPhone =
      input.targetPhone ??
      (await organizationService.getSupervisorPhone(input.organizationId)) ??
      "+6590000000";
    const nextAt = new Date(Date.now() + intervalMin * 60_000);

    const task = await prisma.followUpTask.create({
      data: {
        workflowRunId: input.workflowRunId,
        type: "approval-reminder",
        targetPhone,
        message: input.message,
        intervalMin,
        nextAt,
        maxAttempts: input.maxAttempts ?? 3,
      },
    });

    await enqueueFollowUp(task.id, input.organizationId, intervalMin * 60_000);
  }

  async cancelForWorkflow(workflowRunId: string): Promise<void> {
    await prisma.followUpTask.updateMany({
      where: { workflowRunId, isActive: true },
      data: { isActive: false },
    });
  }

  async handleDue(taskId: string): Promise<void> {
    const task = await prisma.followUpTask.findUnique({ where: { id: taskId } });
    if (!task?.isActive) return;

    const stillWaiting = await prisma.approvalRequest.findFirst({
      where: { workflowRunId: task.workflowRunId, status: "PENDING" },
    });
    if (!stillWaiting) {
      await prisma.followUpTask.update({
        where: { id: taskId },
        data: { isActive: false },
      });
      return;
    }

    try {
      await whatsappService.sendText(
        task.targetPhone,
        `⏰ Reminder:\n${task.message}`
      );
    } catch (error) {
      logger.warn({ err: error, taskId }, "Follow-up reminder failed to send");
    }

    const attempts = task.attempts + 1;
    const maxAttempts = task.maxAttempts ?? 3;
    if (attempts >= maxAttempts) {
      await prisma.followUpTask.update({
        where: { id: taskId },
        data: { isActive: false, attempts },
      });
      return;
    }

    const nextAt = new Date(Date.now() + task.intervalMin * 60_000);
    await prisma.followUpTask.update({
      where: { id: taskId },
      data: { attempts, nextAt },
    });

    const run = await prisma.workflowRun.findUnique({
      where: { id: task.workflowRunId },
      select: { organizationId: true },
    });
    if (!run) return;

    await enqueueFollowUp(task.id, run.organizationId, task.intervalMin * 60_000);
  }
}

export const followUpService = new FollowUpService();
