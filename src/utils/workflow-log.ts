import { logger } from "./logger.js";

const JOB_LABELS: Record<string, string> = {
  "whatsapp.message": "Incoming WhatsApp",
  "approval.resolved": "Supervisor reply",
  "email.scan": "Email inbox scan",
  "invoice.capture": "Invoice capture",
  "reconciliation.payable.ready": "Payable list ready for DBS",
  "payment.monitor": "Check DBS approval",
  "follow-up": "Reminder follow-up",
  "scheduled.fanout": "Scheduled fan-out",
};

export function logJob(name: string, jobId?: string): void {
  logger.info(`>>> ${JOB_LABELS[name] ?? name}${jobId ? ` [${jobId}]` : ""}`);
}

export function logStep(runId: string | undefined, title: string, detail?: string): void {
  const suffix = detail ? ` — ${detail}` : "";
  logger.info({ workflowRunId: runId }, `▶ ${title}${suffix}`);
}

export function logWaiting(runId: string | undefined, whatToDoNext: string): void {
  logger.info({ workflowRunId: runId }, `⏳ WAITING: ${whatToDoNext}`);
}

export function logDone(runId: string | undefined, title: string, detail?: string): void {
  const suffix = detail ? ` — ${detail}` : "";
  logger.info({ workflowRunId: runId }, `✅ ${title}${suffix}`);
}

export function logBotMessage(to: string, text: string, dry: boolean): void {
  const header = dry ? `BOT MESSAGE (not sent — WhatsApp not configured) → ${to}` : `BOT MESSAGE → ${to}`;
  logger.info(`\n----- ${header} -----\n${text}\n-----`);
}
