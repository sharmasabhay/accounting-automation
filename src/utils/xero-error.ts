import { logger } from "./logger.js";
import { tryGetOrganizationId } from "../context/tenant.js";

const notifiedErrors = new WeakSet<object>();

export class XeroApiError extends Error {
  readonly status?: number;
  readonly path?: string;

  constructor(message: string, options?: { status?: number; path?: string }) {
    super(message);
    this.name = "XeroApiError";
    this.status = options?.status;
    this.path = options?.path;
  }
}

export function isXeroError(error: unknown): boolean {
  if (error instanceof XeroApiError) return true;
  return error instanceof Error && /\bxero\b/i.test(error.message);
}

export function describeXeroFailure(error: unknown): { human: string; technical: string } {
  const technical = (error instanceof Error ? error.message : String(error)).trim();
  const lower = technical.toLowerCase();

  let human =
    "Something went wrong while talking to Xero, so I had to stop that step.";

  if (lower.includes("not connected") || lower.includes("oauth not configured")) {
    human =
      "Xero is not connected for this organisation. Connect Xero in Admin → Integrations, then try again.";
  } else if (
    lower.includes("insufficient scope") ||
    lower.includes("accounting.settings") ||
    lower.includes("missing accounting")
  ) {
    human =
      "Xero has not granted this app the permissions it needs. Reconnect Xero in Admin → Integrations and approve the requested access.";
  } else if (
    lower.includes("token refresh") ||
    lower.includes("token expired") ||
    lower.includes("unauthorized") ||
    lower.includes("client credentials missing")
  ) {
    human =
      "The Xero login expired or was rejected. Reconnect Xero in Admin → Integrations.";
  } else if (lower.includes("tenant")) {
    human =
      "The Xero organisation (tenant) is missing or invalid. Reconnect Xero in Admin → Integrations.";
  } else if (lower.includes("contact")) {
    human =
      "Xero could not find or use this supplier's contact. Add the supplier in Admin so a Xero contact is created.";
  } else if (lower.includes("account could not be found") || lower.includes("accountcode")) {
    human =
      "Xero could not find the account used for this document. The app will look up your chart of accounts; if this persists, reconnect Xero in Admin → Integrations.";
  } else if (lower.includes("validation") || lower.includes("did not return")) {
    human =
      "Xero rejected the document because some fields are invalid. Check the details below and correct the order or invoice.";
  } else if (lower.includes("not found")) {
    human = "Xero could not find that purchase order or bill.";
  } else if (lower.includes("not editable")) {
    human = "That purchase order can no longer be edited in Xero (it may already be billed or deleted).";
  } else if (lower.includes("429") || lower.includes("rate")) {
    human = "Xero is temporarily rate-limiting requests. Wait a minute and try again.";
  } else if (/\b5\d\d\b/.test(technical) || lower.includes("unexpected")) {
    human = "Xero had a server problem. Please try again in a few minutes.";
  }

  return { human, technical: technical.slice(0, 500) };
}

export function formatXeroSupervisorWhatsApp(action: string, error: unknown): string {
  const { human, technical } = describeXeroFailure(error);
  return [
    `⚠️ I couldn't ${action} in Xero.`,
    human,
    "",
    `Technical details: ${technical}`,
  ].join("\n");
}

export async function notifySupervisorOfXeroError(
  action: string,
  error: unknown,
  to?: string
): Promise<void> {
  if (typeof error === "object" && error && notifiedErrors.has(error)) return;

  const { organizationService } = await import("../services/organization.service.js");
  const { whatsappService } = await import("../services/whatsapp.service.js");

  const organizationId = tryGetOrganizationId();
  const supervisorPhone = organizationId
    ? await organizationService.getSupervisorPhone(organizationId)
    : null;
  const phone = supervisorPhone ?? to;

  if (!phone) {
    logger.error({ err: error, action }, "Xero error but no supervisor phone to notify");
    return;
  }

  try {
    await whatsappService.sendText(phone, formatXeroSupervisorWhatsApp(action, error));
    if (typeof error === "object" && error) notifiedErrors.add(error);
  } catch (notifyError) {
    logger.error(
      { notifyError, err: error, action },
      "Failed to WhatsApp supervisor about Xero error"
    );
  }
}
