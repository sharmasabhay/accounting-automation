import { Queue, Worker, type JobsOptions } from "bullmq";
import { config } from "../config/index.js";
import { orchestrator } from "../orchestrator/router.js";
import { organizationService } from "../services/organization.service.js";
import { logger } from "../utils/logger.js";

const connection = { url: config.REDIS_URL };

export const workflowQueue = new Queue("omakase-workflows", { connection });

export type JobName =
  | "whatsapp.message"
  | "email.scan"
  | "approval.resolved"
  | "reconciliation.payable.ready"
  | "payment.monitor"
  | "follow-up"
  | "scheduled.fanout";

export async function enqueueJob(
  name: JobName,
  data: Record<string, unknown>,
  options?: JobsOptions
): Promise<void> {
  await workflowQueue.add(name, data, {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    ...options,
  });
}

export function createWorkflowWorker(): Worker {
  const worker = new Worker(
    "omakase-workflows",
    async (job) => {
      logger.info({ jobId: job.id, name: job.name }, "Processing job");

      switch (job.name) {
        case "whatsapp.message":
          await orchestrator.handleEvent({
            type: "whatsapp.message",
            payload: job.data as import("../types/index.js").WhatsAppInboundMessage,
          });
          break;
        case "scheduled.fanout": {
          const targetJob = job.data.targetJob as "email.scan" | "payment.monitor";
          const organizations = await organizationService.listActiveOrganizations();
          for (const org of organizations) {
            await orchestrator.handleEvent({
              type: targetJob,
              payload: { scheduledAt: new Date().toISOString(), organizationId: org.id },
            } as import("../types/index.js").WorkflowEvent);
          }
          break;
        }
        case "email.scan":
          await orchestrator.handleEvent({
            type: "email.scan",
            payload: job.data as { scheduledAt: string; organizationId: string },
          });
          break;
        case "approval.resolved":
          await orchestrator.handleEvent({
            type: "approval.resolved",
            payload: job.data as {
              approvalId: string;
              response: string;
              organizationId: string;
            },
          });
          break;
        case "reconciliation.payable.ready":
          await orchestrator.handleEvent({
            type: "reconciliation.payable.ready",
            payload: job.data as { reconciliationRunId: string; organizationId: string },
          });
          break;
        case "payment.monitor":
          await orchestrator.handleEvent({
            type: "payment.monitor",
            payload: job.data as { scheduledAt: string; organizationId: string },
          });
          break;
        default:
          logger.warn({ name: job.name }, "Unknown job type");
      }
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err }, "Job failed");
  });

  return worker;
}

export async function setupSchedulers(): Promise<void> {
  // Fan out daily email scan to all organizations
  await workflowQueue.upsertJobScheduler(
    "daily-email-scan",
    { pattern: "0 0 * * *" },
    { name: "scheduled.fanout", data: { targetJob: "email.scan" } }
  );

  // Fan out payment approval monitor to all organizations
  await workflowQueue.upsertJobScheduler(
    "payment-approval-monitor",
    { pattern: "0 */4 * * *" },
    { name: "scheduled.fanout", data: { targetJob: "payment.monitor" } }
  );

  logger.info("Job schedulers registered (multi-tenant fan-out)");
}
