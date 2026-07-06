import { IntegrationType } from "@prisma/client";
import { config } from "../config/index.js";
import { organizationService } from "./organization.service.js";
import type {
  DbsIntegrationConfig,
  EmailIntegrationConfig,
  IntegrationConfigMap,
  WhatsAppIntegrationConfig,
  XeroIntegrationConfig,
} from "../types/integrations.js";

const SENSITIVE_KEYS = new Set([
  "apiToken",
  "imapPassword",
  "clientSecret",
  "password",
  "awsSecretAccessKey",
]);

function maskValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (value.length <= 4) return "****";
  return `${"*".repeat(Math.min(value.length - 4, 12))}${value.slice(-4)}`;
}

export function maskIntegrationConfig(
  cfg: Record<string, unknown>
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    masked[key] = SENSITIVE_KEYS.has(key) ? maskValue(value) : value;
  }
  return masked;
}

async function loadOrgConfig<T extends keyof IntegrationConfigMap>(
  organizationId: string,
  type: T
): Promise<IntegrationConfigMap[T]> {
  const integration = await organizationService.getIntegration(organizationId, type);
  return (integration?.config ?? {}) as IntegrationConfigMap[T];
}

class IntegrationConfigService {
  async getWhatsApp(organizationId: string): Promise<Required<Pick<WhatsAppIntegrationConfig, "apiToken" | "phoneNumberId">> & WhatsAppIntegrationConfig> {
    const org = await loadOrgConfig(organizationId, IntegrationType.WHATSAPP);
    return {
      apiToken: org.apiToken ?? config.WHATSAPP_API_TOKEN ?? "",
      phoneNumberId: org.phoneNumberId ?? config.WHATSAPP_PHONE_NUMBER_ID ?? "",
      verifyToken: org.verifyToken ?? config.WHATSAPP_VERIFY_TOKEN,
      businessAccountId: org.businessAccountId ?? config.WHATSAPP_BUSINESS_ACCOUNT_ID,
    };
  }

  async getEmail(organizationId: string): Promise<EmailIntegrationConfig> {
    const org = await loadOrgConfig(organizationId, IntegrationType.EMAIL);
    return {
      imapHost: org.imapHost ?? config.EMAIL_IMAP_HOST,
      imapPort: org.imapPort ?? config.EMAIL_IMAP_PORT,
      imapUser: org.imapUser ?? config.EMAIL_IMAP_USER,
      imapPassword: org.imapPassword ?? config.EMAIL_IMAP_PASSWORD,
      inboxFolder: org.inboxFolder ?? config.EMAIL_INBOX_FOLDER,
      processedFolder: org.processedFolder ?? config.EMAIL_PROCESSED_FOLDER,
    };
  }

  async getXero(organizationId: string): Promise<XeroIntegrationConfig> {
    const org = await loadOrgConfig(organizationId, IntegrationType.XERO);
    return {
      clientId: org.clientId ?? config.XERO_CLIENT_ID,
      clientSecret: org.clientSecret ?? config.XERO_CLIENT_SECRET,
      redirectUri: org.redirectUri ?? config.XERO_REDIRECT_URI,
      tenantId: org.tenantId ?? config.XERO_TENANT_ID,
      connected: org.connected,
      connectedAt: org.connectedAt,
    };
  }

  async getDbs(organizationId: string): Promise<DbsIntegrationConfig> {
    const org = await loadOrgConfig(organizationId, IntegrationType.DBS);
    return {
      idealUrl: org.idealUrl ?? config.DBS_IDEAL_URL,
      orgId: org.orgId ?? config.DBS_ORG_ID,
      userId: org.userId ?? config.DBS_USER_ID,
      password: org.password,
      headless: org.headless ?? config.DBS_HEADLESS,
    };
  }

  isWhatsAppConfigured(cfg: WhatsAppIntegrationConfig): boolean {
    return Boolean(cfg.apiToken && cfg.phoneNumberId);
  }

  isEmailConfigured(cfg: EmailIntegrationConfig): boolean {
    return Boolean(cfg.imapHost && cfg.imapUser && cfg.imapPassword);
  }

  isXeroConfigured(cfg: XeroIntegrationConfig): boolean {
    return Boolean(cfg.clientId && cfg.clientSecret);
  }

  isDbsConfigured(cfg: DbsIntegrationConfig): boolean {
    return Boolean(cfg.orgId && cfg.userId);
  }
}

export const integrationConfigService = new IntegrationConfigService();
