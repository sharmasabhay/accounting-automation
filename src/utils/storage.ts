import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config/index.js";

export async function ensureStorageDirs(): Promise<void> {
  await fs.mkdir(config.invoicesPath, { recursive: true, mode: 0o700 });
  await fs.mkdir(config.auditLogPath, { recursive: true, mode: 0o700 });
}

export async function saveUploadedFile(
  buffer: Buffer,
  filename: string,
  organizationId?: string
): Promise<string> {
  const orgId = organizationId ?? (await import("../context/tenant.js")).getOrganizationId();
  const orgInvoicesPath = path.join(config.invoicesPath, orgId);
  await fs.mkdir(orgInvoicesPath, { recursive: true, mode: 0o700 });

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const uniqueName = `${Date.now()}-${safeName}`;
  const filePath = path.join(orgInvoicesPath, uniqueName);
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
}

export function formatLocalTimestamp(date: Date = new Date()): string {
  return date.toLocaleString("en-SG", {
    timeZone: config.TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; delaysMs?: number[]; label?: string } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delaysMs = options.delaysMs ?? [1000, 4000, 16000];
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = delaysMs[attempt - 1] ?? delaysMs[delaysMs.length - 1] ?? 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
