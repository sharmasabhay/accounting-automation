import { config as loadEnv } from "dotenv";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("127.0.0.1"),
  API_TOKEN: z.string().min(8),
  DRY_RUN: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  TIMEZONE: z.string().default("Asia/Singapore"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  XERO_REDIRECT_URI: z.string().optional(),
  XERO_TENANT_ID: z.string().optional(),
  WHATSAPP_API_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  // Meta partner app (Tech Provider) for WhatsApp Embedded Signup
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_CONFIG_ID: z.string().optional(),
  META_GRAPH_VERSION: z.string().default("v21.0"),
  // Public URL of this server (tunnel/domain) used in tenant onboarding links
  PUBLIC_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-20250514"),
  OCR_PROVIDER: z.enum(["mock", "claude", "google", "aws"]).default("mock"),
  GOOGLE_DOCUMENT_AI_PROJECT_ID: z.string().optional(),
  GOOGLE_DOCUMENT_AI_LOCATION: z.string().optional(),
  GOOGLE_DOCUMENT_AI_PROCESSOR_ID: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  EMAIL_IMAP_HOST: z.string().optional(),
  EMAIL_IMAP_PORT: z.coerce.number().default(993),
  EMAIL_IMAP_USER: z.string().optional(),
  EMAIL_IMAP_PASSWORD: z.string().optional(),
  EMAIL_INBOX_FOLDER: z.string().default("INBOX"),
  EMAIL_PROCESSED_FOLDER: z.string().default("Processed"),
  DBS_IDEAL_URL: z.string().default("https://ideal.dbs.com"),
  DBS_ORG_ID: z.string().optional(),
  DBS_USER_ID: z.string().optional(),
  DBS_HEADLESS: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  SUPERVISOR_PHONE: z.string().optional(),
  STORAGE_PATH: z.string().default("./storage"),
  AUDIT_LOG_PATH: z.string().default("./storage/audit-logs"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  projectRoot,
  storagePath: path.resolve(projectRoot, parsed.data.STORAGE_PATH),
  auditLogPath: path.resolve(projectRoot, parsed.data.AUDIT_LOG_PATH),
  invoicesPath: path.resolve(projectRoot, parsed.data.STORAGE_PATH, "invoices"),
  isDevelopment: parsed.data.NODE_ENV === "development",
  isProduction: parsed.data.NODE_ENV === "production",
};

export type AppConfig = typeof config;
