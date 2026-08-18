import crypto from "node:crypto";
import { IntegrationType, OnboardingSessionStatus, type WhatsAppOnboardingSession } from "@prisma/client";
import { config } from "../config/index.js";
import { prisma } from "../db/client.js";
import { logger } from "../utils/logger.js";
import { organizationService } from "./organization.service.js";
import type { WhatsAppIntegrationConfig } from "../types/integrations.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface EmbeddedSignupResult {
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
}

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number };
}

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${config.META_GRAPH_VERSION}/${path}`;
}

async function graphFetch<T>(
  path: string,
  init?: RequestInit & { accessToken?: string }
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.accessToken) {
    headers.Authorization = `Bearer ${init.accessToken}`;
  }
  if (init?.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(graphUrl(path), { ...init, headers });
  const data = (await response.json().catch(() => ({}))) as T & GraphErrorBody;

  if (!response.ok) {
    const message = data.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Meta Graph API error: ${message}`);
  }

  return data;
}

class WhatsAppOnboardingService {
  isPartnerAppConfigured(): boolean {
    return Boolean(config.META_APP_ID && config.META_APP_SECRET && config.META_CONFIG_ID);
  }

  /** Public settings safe to embed in the tenant-facing onboarding page. */
  getEmbeddedSignupSettings(): { appId: string; configId: string; graphVersion: string } {
    return {
      appId: config.META_APP_ID ?? "",
      configId: config.META_CONFIG_ID ?? "",
      graphVersion: config.META_GRAPH_VERSION,
    };
  }

  buildOnboardingUrl(token: string): string {
    const base = config.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? `http://${config.HOST}:${config.PORT}`;
    return `${base}/onboarding/whatsapp/${token}`;
  }

  async createSession(organizationId: string): Promise<WhatsAppOnboardingSession> {
    // Invalidate previous pending sessions so only the newest link works
    await prisma.whatsAppOnboardingSession.updateMany({
      where: { organizationId, status: OnboardingSessionStatus.PENDING },
      data: { status: OnboardingSessionStatus.EXPIRED },
    });

    return prisma.whatsAppOnboardingSession.create({
      data: {
        organizationId,
        token: crypto.randomBytes(24).toString("base64url"),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
  }

  async getValidSession(token: string) {
    const session = await prisma.whatsAppOnboardingSession.findUnique({
      where: { token },
      include: { organization: true },
    });

    if (!session || !session.organization.isActive) return null;
    if (session.status === OnboardingSessionStatus.COMPLETED) return session;

    if (session.status !== OnboardingSessionStatus.PENDING) return null;

    if (session.expiresAt.getTime() < Date.now()) {
      await prisma.whatsAppOnboardingSession.update({
        where: { id: session.id },
        data: { status: OnboardingSessionStatus.EXPIRED },
      });
      return null;
    }

    return session;
  }

  async listSessions(organizationId: string) {
    return prisma.whatsAppOnboardingSession.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        token: true,
        status: true,
        wabaId: true,
        phoneNumberId: true,
        error: true,
        expiresAt: true,
        completedAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Complete Embedded Signup: exchange the auth code for a business token,
   * subscribe our app to the tenant's WABA (so we receive their webhooks),
   * register the phone number for Cloud API, and persist the org integration.
   */
  async completeSignup(token: string, result: EmbeddedSignupResult) {
    const session = await this.getValidSession(token);
    if (!session) {
      throw new Error("Onboarding link is invalid or has expired");
    }
    if (session.status === OnboardingSessionStatus.COMPLETED) {
      throw new Error("This onboarding link has already been used");
    }
    if (!this.isPartnerAppConfigured()) {
      throw new Error("Partner app is not configured (META_APP_ID / META_APP_SECRET / META_CONFIG_ID)");
    }

    try {
      const accessToken = await this.exchangeCode(result.code);

      const wabaId = result.wabaId ?? (await this.findSharedWabaId(accessToken));
      if (!wabaId) {
        throw new Error("Could not determine the WhatsApp Business Account ID from signup");
      }

      await this.subscribeAppToWaba(wabaId, accessToken);

      let phoneNumberId = result.phoneNumberId;
      let displayPhoneNumber: string | undefined;

      const phones = await this.listWabaPhoneNumbers(wabaId, accessToken);
      if (!phoneNumberId) {
        phoneNumberId = phones[0]?.id;
      }
      displayPhoneNumber = phones.find((p) => p.id === phoneNumberId)?.display_phone_number;

      if (!phoneNumberId) {
        throw new Error("No phone number found on the WhatsApp Business Account");
      }

      await this.registerPhoneNumber(phoneNumberId, accessToken);

      const organizationId = session.organizationId;
      const existing = await organizationService.getIntegration(
        organizationId,
        IntegrationType.WHATSAPP
      );
      const merged: WhatsAppIntegrationConfig = {
        ...((existing?.config ?? {}) as WhatsAppIntegrationConfig),
        apiToken: accessToken,
        phoneNumberId,
        businessAccountId: wabaId,
        displayPhoneNumber,
        onboardedVia: "embedded_signup",
        onboardedAt: new Date().toISOString(),
      };
      await organizationService.setIntegration(
        organizationId,
        IntegrationType.WHATSAPP,
        merged as Record<string, unknown>
      );

      const completed = await prisma.whatsAppOnboardingSession.update({
        where: { id: session.id },
        data: {
          status: OnboardingSessionStatus.COMPLETED,
          wabaId,
          phoneNumberId,
          error: null,
          completedAt: new Date(),
        },
      });

      logger.info(
        { organizationId, wabaId, phoneNumberId },
        "WhatsApp Embedded Signup completed for tenant"
      );

      return { session: completed, wabaId, phoneNumberId, displayPhoneNumber };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Signup failed";
      await prisma.whatsAppOnboardingSession.update({
        where: { id: session.id },
        data: { status: OnboardingSessionStatus.FAILED, error: message },
      });
      throw error;
    }
  }

  /** Exchange the Embedded Signup auth code for a long-lived business token. */
  private async exchangeCode(code: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: config.META_APP_ID ?? "",
      client_secret: config.META_APP_SECRET ?? "",
      code,
    });
    const data = await graphFetch<{ access_token?: string }>(
      `oauth/access_token?${params.toString()}`
    );
    if (!data.access_token) {
      throw new Error("Meta did not return an access token for the signup code");
    }
    return data.access_token;
  }

  /** Fallback: find the WABA the tenant shared with our app via the token's granted scopes. */
  private async findSharedWabaId(accessToken: string): Promise<string | undefined> {
    const params = new URLSearchParams({
      input_token: accessToken,
      access_token: `${config.META_APP_ID}|${config.META_APP_SECRET}`,
    });
    const data = await graphFetch<{
      data?: {
        granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
      };
    }>(`debug_token?${params.toString()}`);

    const scope = data.data?.granular_scopes?.find(
      (s) => s.scope === "whatsapp_business_management" || s.scope === "whatsapp_business_messaging"
    );
    return scope?.target_ids?.[0];
  }

  /** Subscribe our app to the tenant's WABA so their events hit our webhook. */
  private async subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
    await graphFetch<{ success?: boolean }>(`${wabaId}/subscribed_apps`, {
      method: "POST",
      accessToken,
    });
  }

  private async listWabaPhoneNumbers(
    wabaId: string,
    accessToken: string
  ): Promise<Array<{ id: string; display_phone_number?: string }>> {
    try {
      const data = await graphFetch<{
        data?: Array<{ id: string; display_phone_number?: string }>;
      }>(`${wabaId}/phone_numbers`, { accessToken });
      return data.data ?? [];
    } catch (error) {
      logger.warn({ wabaId, error }, "Failed to list WABA phone numbers");
      return [];
    }
  }

  /** Register the number for Cloud API messaging. Tolerates already-registered numbers. */
  private async registerPhoneNumber(phoneNumberId: string, accessToken: string): Promise<void> {
    try {
      await graphFetch<{ success?: boolean }>(`${phoneNumberId}/register`, {
        method: "POST",
        accessToken,
        body: JSON.stringify({ messaging_product: "whatsapp", pin: "000000" }),
      });
    } catch (error) {
      // Registration fails if the number is already registered or needs a custom
      // two-step PIN — the tenant can still message once registered manually.
      logger.warn({ phoneNumberId, error }, "Phone number registration skipped/failed");
    }
  }
}

export const whatsappOnboardingService = new WhatsAppOnboardingService();
