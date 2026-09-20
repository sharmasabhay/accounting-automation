import nodemailer from "nodemailer";
import { config } from "../config/index.js";
import { tryGetOrganizationId } from "../context/tenant.js";

const ALERT_TO = "sharmasabhay@gmail.com";
const DEDUP_MS = 60_000;
const MAX_JSON = 50_000;
const SENSITIVE = /secret|password|token|authorization|cookie|apikey|api_key|clientsecret|client_secret|refresh/i;

const recent = new Map<string, number>();
const emailed = new WeakSet<object>();
let sending = false;
let missingSmtpLogged = false;

export interface BackendErrorReport {
  source: "api" | "workflow" | "job" | "log" | "process";
  error: unknown;
  context?: Record<string, unknown>;
}

export async function reportBackendError(report: BackendErrorReport): Promise<void> {
  if (sending) return;

  const error = report.error;
  if (typeof error === "object" && error && emailed.has(error)) return;

  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  const key = `${report.source}|${message}|${stack.slice(0, 200)}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < DEDUP_MS) return;
  recent.set(key, now);
  if (typeof error === "object" && error) emailed.add(error);

  const organizationId = tryGetOrganizationId();
  const context = redactValue({
    organizationId,
    ...(report.context ?? {}),
  });

  const body = [
    `Source: ${report.source}`,
    `Time: ${new Date().toISOString()}`,
    organizationId ? `Organization ID: ${organizationId}` : null,
    "",
    "Error message:",
    message,
    "",
    "Stack:",
    stack || "(no stack)",
    "",
    "Request / job data:",
    stringify(context),
  ]
    .filter((line) => line !== null)
    .join("\n");

  const subject = `[Omakase] ${report.source} error: ${message}`.slice(0, 180);

  try {
    sending = true;
    await sendAlertEmail(subject, body);
  } catch (sendError) {
    console.error("Failed to send backend error alert email:", sendError);
  } finally {
    sending = false;
  }
}

export function reportBackendErrorFromLog(args: unknown[], _level: number): void {
  const obj = args[0];
  const msg = typeof args[1] === "string" ? args[1] : typeof obj === "string" ? obj : "backend error";
  const error =
    extractError(obj) ??
    (typeof obj === "string" ? new Error(obj) : new Error(msg));
  const context =
    obj && typeof obj === "object" && !(obj instanceof Error)
      ? (obj as Record<string, unknown>)
      : { logMessage: msg };

  void reportBackendError({ source: "log", error, context: { logMessage: msg, ...context } });
}

export function installProcessErrorAlerts(): void {
  process.on("unhandledRejection", (reason) => {
    void reportBackendError({
      source: "process",
      error: reason,
      context: { kind: "unhandledRejection" },
    });
  });
  process.on("uncaughtException", (error) => {
    void reportBackendError({
      source: "process",
      error,
      context: { kind: "uncaughtException" },
    });
  });
}

function extractError(value: unknown): unknown {
  if (value instanceof Error) return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return record.err ?? record.error ?? record.notifyError;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE.test(key) ? "[redacted]" : redactValue(nested, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 4000) return `${value.slice(0, 4000)}…`;
  return value;
}

function stringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2) ?? "null";
    return json.length > MAX_JSON ? `${json.slice(0, MAX_JSON)}\n…[truncated]` : json;
  } catch {
    return String(value);
  }
}

function smtpConfig(): { host: string; port: number; user: string; pass: string; from: string } | null {
  const user = config.ERROR_ALERT_SMTP_USER || config.EMAIL_IMAP_USER;
  const pass = config.ERROR_ALERT_SMTP_PASSWORD || config.EMAIL_IMAP_PASSWORD;
  if (!user || !pass) return null;

  const looksGmail = /gmail\.com$/i.test(user) || /gmail/i.test(config.EMAIL_IMAP_HOST ?? "");
  const host = config.ERROR_ALERT_SMTP_HOST || (looksGmail ? "smtp.gmail.com" : "");
  if (!host) return null;

  return {
    host,
    port: config.ERROR_ALERT_SMTP_PORT,
    user,
    pass,
    from: config.ERROR_ALERT_FROM || user,
  };
}

async function sendAlertEmail(subject: string, text: string): Promise<void> {
  const smtp = smtpConfig();
  if (!smtp) {
    if (!missingSmtpLogged) {
      missingSmtpLogged = true;
      console.error(
        "Backend error alerts are enabled but SMTP is not configured. Set ERROR_ALERT_SMTP_USER/PASSWORD or EMAIL_IMAP_USER/PASSWORD."
      );
    }
    console.error(`Error alert (not emailed):\n${subject}\n${text.slice(0, 2000)}`);
    return;
  }

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  await transport.sendMail({
    from: smtp.from,
    to: config.ERROR_ALERT_EMAIL || ALERT_TO,
    subject,
    text,
  });
}
