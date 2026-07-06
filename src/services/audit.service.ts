import fs from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { config } from "../config/index.js";
import { getOrganizationId } from "../context/tenant.js";
import { formatLocalTimestamp } from "../utils/storage.js";
import { logger } from "../utils/logger.js";

export interface AuditEntryInput {
  workflowRunId?: string;
  organizationId?: string;
  triggerEvent: string;
  actor: string;
  sourceChannel: string;
  inputs?: Record<string, unknown>;
  decisions?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  outcome: string;
}

class AuditService {
  async log(entry: AuditEntryInput): Promise<void> {
    const organizationId = entry.organizationId ?? getOrganizationId();
    const now = new Date();
    const timestampLocal = formatLocalTimestamp(now);

    await prisma.auditLogEntry.create({
      data: {
        organizationId,
        workflowRunId: entry.workflowRunId,
        timestampUtc: now,
        timestampLocal,
        triggerEvent: entry.triggerEvent,
        actor: entry.actor,
        sourceChannel: entry.sourceChannel,
        inputs: (entry.inputs ?? undefined) as Prisma.InputJsonValue | undefined,
        decisions: (entry.decisions ?? undefined) as Prisma.InputJsonValue | undefined,
        outputs: (entry.outputs ?? undefined) as Prisma.InputJsonValue | undefined,
        outcome: entry.outcome,
      },
    });

    const line = JSON.stringify({
      ...entry,
      organizationId,
      timestampUtc: now.toISOString(),
      timestampLocal,
    });

    const orgLogDir = path.join(config.auditLogPath, organizationId);
    await fs.mkdir(orgLogDir, { recursive: true, mode: 0o700 });

    const logFile = path.join(orgLogDir, `audit-${now.toISOString().slice(0, 10)}.jsonl`);

    try {
      await fs.appendFile(logFile, `${line}\n`, { mode: 0o600 });
    } catch (error) {
      logger.error({ error }, "Failed to write audit log file");
    }
  }
}

export const auditService = new AuditService();
