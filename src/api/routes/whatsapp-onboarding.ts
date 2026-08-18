import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { config } from "../../config/index.js";
import { organizationService } from "../../services/organization.service.js";
import { whatsappOnboardingService } from "../../services/whatsapp-onboarding.service.js";

const ONBOARDING_PAGE = path.join(config.projectRoot, "public/onboarding/whatsapp.html");

export async function registerWhatsAppOnboardingRoutes(app: FastifyInstance): Promise<void> {
  // --- Tenant-facing (public, token-gated) ---

  app.get("/onboarding/whatsapp/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const session = await whatsappOnboardingService.getValidSession(token);

    if (!session) {
      return reply
        .code(404)
        .type("text/html")
        .send(invalidLinkPage());
    }

    const html = await fs.readFile(ONBOARDING_PAGE, "utf8");
    return reply.type("text/html").send(html);
  });

  app.get("/onboarding/whatsapp/:token/session", async (request, reply) => {
    const { token } = request.params as { token: string };
    const session = await whatsappOnboardingService.getValidSession(token);

    if (!session) {
      return reply.code(404).send({ error: "Onboarding link is invalid or has expired" });
    }

    return {
      organizationName: session.organization.name,
      status: session.status,
      completed: session.status === "COMPLETED",
      wabaId: session.wabaId,
      phoneNumberId: session.phoneNumberId,
      expiresAt: session.expiresAt,
      partnerConfigured: whatsappOnboardingService.isPartnerAppConfigured(),
      signup: whatsappOnboardingService.getEmbeddedSignupSettings(),
    };
  });

  app.post("/onboarding/whatsapp/:token/complete", async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = request.body as {
      code?: string;
      wabaId?: string;
      phoneNumberId?: string;
    };

    if (!body.code) {
      return reply.code(400).send({ error: "Missing signup code from Meta" });
    }

    try {
      const result = await whatsappOnboardingService.completeSignup(token, {
        code: body.code,
        wabaId: body.wabaId,
        phoneNumberId: body.phoneNumberId,
      });

      return {
        ok: true,
        wabaId: result.wabaId,
        phoneNumberId: result.phoneNumberId,
        displayPhoneNumber: result.displayPhoneNumber,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Onboarding failed";
      return reply.code(400).send({ error: message });
    }
  });

  // --- Admin (bearer-token protected via global hook) ---

  app.post(
    "/api/organizations/:idOrSlug/whatsapp/onboarding-link",
    async (request, reply) => {
      const { idOrSlug } = request.params as { idOrSlug: string };
      const organization = await organizationService.getByIdOrSlug(idOrSlug);
      if (!organization) {
        return reply.code(404).send({ error: "Organization not found" });
      }

      if (!whatsappOnboardingService.isPartnerAppConfigured()) {
        return reply.code(400).send({
          error: "Partner app not configured",
          hint: "Set META_APP_ID, META_APP_SECRET, and META_CONFIG_ID in .env first.",
        });
      }

      const session = await whatsappOnboardingService.createSession(organization.id);

      return reply.code(201).send({
        token: session.token,
        url: whatsappOnboardingService.buildOnboardingUrl(session.token),
        expiresAt: session.expiresAt,
      });
    }
  );

  app.get("/api/organizations/:idOrSlug/whatsapp/onboarding", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const sessions = await whatsappOnboardingService.listSessions(organization.id);
    const pending = sessions.find((s) => s.status === "PENDING");

    return {
      partnerConfigured: whatsappOnboardingService.isPartnerAppConfigured(),
      pendingLink: pending
        ? {
            url: whatsappOnboardingService.buildOnboardingUrl(pending.token),
            expiresAt: pending.expiresAt,
          }
        : null,
      sessions: sessions.map(({ token: _token, ...rest }) => rest),
    };
  });
}

function invalidLinkPage(): string {
  return `<!DOCTYPE html><html><head><title>Link expired</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;text-align:center;color:#1f2937}
.err{color:#dc2626}</style></head><body>
<h1 class="err">Link invalid or expired</h1>
<p>This WhatsApp onboarding link is no longer valid. Please ask your account manager for a new link.</p>
</body></html>`;
}
