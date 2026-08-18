/** Per-organization integration config shapes stored in OrganizationIntegration.config */

export interface WhatsAppIntegrationConfig {
  apiToken?: string;
  phoneNumberId?: string;
  verifyToken?: string;
  businessAccountId?: string;
  displayPhoneNumber?: string;
  /** "embedded_signup" when authorized via the tenant onboarding page */
  onboardedVia?: string;
  onboardedAt?: string;
}

export interface EmailIntegrationConfig {
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPassword?: string;
  inboxFolder?: string;
  processedFolder?: string;
}

export interface XeroIntegrationConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  tenantId?: string;
  connected?: boolean;
  connectedAt?: string;
}

export interface DbsIntegrationConfig {
  idealUrl?: string;
  orgId?: string;
  userId?: string;
  password?: string;
  headless?: boolean;
}

export interface OcrIntegrationConfig {
  provider?: "mock" | "google" | "aws";
  googleProjectId?: string;
  googleLocation?: string;
  googleProcessorId?: string;
  awsRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
}

export type IntegrationConfigMap = {
  WHATSAPP: WhatsAppIntegrationConfig;
  EMAIL: EmailIntegrationConfig;
  XERO: XeroIntegrationConfig;
  DBS: DbsIntegrationConfig;
  OCR: OcrIntegrationConfig;
};

export const INTEGRATION_FIELDS: Record<
  keyof IntegrationConfigMap,
  Array<{ key: string; label: string; type: "text" | "password" | "number" | "boolean" | "select"; options?: string[]; help?: string }>
> = {
  WHATSAPP: [
    { key: "apiToken", label: "API Token", type: "password", help: "Filled automatically by Embedded Signup, or paste a Meta permanent token" },
    { key: "phoneNumberId", label: "Phone Number ID", type: "text", help: "Filled by Embedded Signup, or from Meta → WhatsApp → API Setup" },
    { key: "verifyToken", label: "Webhook Verify Token", type: "text", help: "Usually the global WHATSAPP_VERIFY_TOKEN — only needed for manual setups" },
    { key: "businessAccountId", label: "Business Account ID (WABA)", type: "text", help: "Filled by Embedded Signup — used to route webhooks to this tenant" },
    { key: "displayPhoneNumber", label: "Display phone number", type: "text", help: "Human-readable number shown after onboarding (read-only)" },
  ],
  EMAIL: [
    { key: "imapHost", label: "IMAP Host", type: "text", help: "e.g. imap.gmail.com" },
    { key: "imapPort", label: "IMAP Port", type: "number", help: "Usually 993 for SSL" },
    { key: "imapUser", label: "IMAP Username", type: "text", help: "Dedicated invoice inbox email address" },
    { key: "imapPassword", label: "IMAP Password", type: "password", help: "App password for Gmail/M365" },
    { key: "inboxFolder", label: "Inbox Folder", type: "text", help: "Default: INBOX" },
    { key: "processedFolder", label: "Processed Folder", type: "text", help: "Folder to move emails after processing" },
  ],
  XERO: [
    { key: "clientId", label: "Client ID", type: "text", help: "From Xero Developer Portal app" },
    { key: "clientSecret", label: "Client Secret", type: "password", help: "Xero app client secret" },
    { key: "redirectUri", label: "Redirect URI", type: "text", help: "OAuth callback — default http://127.0.0.1:3000/auth/xero/callback" },
    { key: "tenantId", label: "Xero Tenant ID", type: "text", help: "Filled automatically after Connect, or set manually" },
  ],
  DBS: [
    { key: "idealUrl", label: "DBS IDEAL URL", type: "text", help: "Default: https://ideal.dbs.com" },
    { key: "orgId", label: "Organisation ID", type: "text", help: "DBS IDEAL login Organisation ID" },
    { key: "userId", label: "User ID", type: "text", help: "DBS IDEAL login User ID" },
    { key: "password", label: "Password", type: "password", help: "Stored locally — used by Playwright automation" },
    { key: "headless", label: "Headless Browser", type: "boolean", help: "Run Playwright without visible browser" },
  ],
  OCR: [
    { key: "provider", label: "Provider", type: "select", options: ["mock", "google", "aws"] },
    { key: "googleProjectId", label: "Google Project ID", type: "text" },
    { key: "googleLocation", label: "Google Location", type: "text" },
    { key: "googleProcessorId", label: "Google Processor ID", type: "text" },
    { key: "awsRegion", label: "AWS Region", type: "text" },
    { key: "awsAccessKeyId", label: "AWS Access Key ID", type: "text" },
    { key: "awsSecretAccessKey", label: "AWS Secret Access Key", type: "password" },
  ],
};
