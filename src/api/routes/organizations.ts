import type { FastifyInstance } from "fastify";
import { IntegrationType, TeamMemberRole } from "@prisma/client";
import { organizationService } from "../../services/organization.service.js";
import { integrationConfigService, maskIntegrationConfig } from "../../services/integration-config.service.js";
import { xeroService } from "../../services/xero.service.js";
import { prisma } from "../../db/client.js";
import { enqueueJob } from "../../jobs/queue.js";
import {
  buildTestWebhookPayload,
  processWhatsAppWebhook,
} from "../webhooks/whatsapp.js";
import { INTEGRATION_FIELDS } from "../../types/integrations.js";

const SENSITIVE_KEYS = new Set([
  "apiToken",
  "imapPassword",
  "clientSecret",
  "password",
  "awsSecretAccessKey",
]);

function mergeIntegrationConfig(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || value === "") continue;
    if (SENSITIVE_KEYS.has(key) && typeof value === "string" && value.includes("***")) continue;
    merged[key] = value;
  }
  return merged;
}

export async function registerOrganizationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/integration-schemas", async () => {
    return INTEGRATION_FIELDS;
  });

  app.post("/api/organizations", async (request, reply) => {
    const body = request.body as {
      name: string;
      slug: string;
      timezone?: string;
      supervisor?: { name: string; phoneNumber: string };
    };

    if (!body.name || !body.slug) {
      return reply.code(400).send({ error: "name and slug are required" });
    }

    const organization = await organizationService.create({
      name: body.name,
      slug: body.slug,
      timezone: body.timezone,
    });

    if (body.supervisor) {
      await organizationService.addTeamMember(organization.id, {
        name: body.supervisor.name,
        phoneNumber: body.supervisor.phoneNumber,
        role: TeamMemberRole.SUPERVISOR,
      });
    }

    return reply.code(201).send(organization);
  });

  app.get("/api/organizations", async () => {
    return organizationService.list();
  });

  app.get("/api/organizations/:idOrSlug", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);

    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const [teamMembers, suppliers, integrations, xeroStatus] = await Promise.all([
      prisma.teamMember.findMany({
        where: { organizationId: organization.id, isActive: true },
      }),
      prisma.supplier.findMany({
        where: { organizationId: organization.id, isActive: true },
      }),
      organizationService.listIntegrations(organization.id),
      xeroService.getConnectionStatus(organization.id),
    ]);

    const maskedIntegrations = integrations.map((i) => ({
      ...i,
      config: maskIntegrationConfig(i.config as Record<string, unknown>),
    }));

    return {
      ...organization,
      teamMembers,
      suppliers,
      integrations: maskedIntegrations,
      xeroStatus,
    };
  });

  app.patch("/api/organizations/:idOrSlug", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const body = request.body as {
      name?: string;
      timezone?: string;
      isActive?: boolean;
      settings?: Record<string, unknown>;
    };

    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const updated = await organizationService.update(organization.id, body);
    return updated;
  });

  app.post("/api/organizations/:idOrSlug/team-members", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const body = request.body as { name: string; phoneNumber: string; role?: TeamMemberRole };

    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const member = await organizationService.addTeamMember(organization.id, body);
    return reply.code(201).send(member);
  });

  app.delete("/api/organizations/:idOrSlug/team-members/:memberId", async (request, reply) => {
    const { idOrSlug, memberId } = request.params as { idOrSlug: string; memberId: string };

    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const member = await organizationService.removeTeamMember(organization.id, memberId);
    if (!member) {
      return reply.code(404).send({ error: "Team member not found" });
    }

    return { ok: true, id: member.id };
  });

  app.post("/api/organizations/:idOrSlug/suppliers", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const body = request.body as {
      name: string;
      emailDomain?: string;
      xeroContactId?: string;
      whatsappGroupId?: string;
      dbsPayeeName?: string;
    };

    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const supplier = await organizationService.addSupplier(organization.id, body);
    return reply.code(201).send(supplier);
  });

  app.patch("/api/organizations/:idOrSlug/suppliers/:supplierId", async (request, reply) => {
    const { idOrSlug, supplierId } = request.params as {
      idOrSlug: string;
      supplierId: string;
    };
    const body = request.body as {
      name?: string;
      emailDomain?: string | null;
      xeroContactId?: string | null;
      whatsappGroupId?: string | null;
      dbsPayeeName?: string | null;
    };

    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    try {
      const supplier = await organizationService.updateSupplier(
        organization.id,
        supplierId,
        body
      );
      if (!supplier) {
        return reply.code(404).send({ error: "Supplier not found" });
      }
      return supplier;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Update failed";
      return reply.code(400).send({ error: message });
    }
  });

  app.delete("/api/organizations/:idOrSlug/suppliers/:supplierId", async (request, reply) => {
    const { idOrSlug, supplierId } = request.params as {
      idOrSlug: string;
      supplierId: string;
    };

    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const supplier = await organizationService.removeSupplier(organization.id, supplierId);
    if (!supplier) {
      return reply.code(404).send({ error: "Supplier not found" });
    }

    return { ok: true, id: supplier.id };
  });

  app.get("/api/organizations/:idOrSlug/integrations", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const integrations = await organizationService.listIntegrations(organization.id);
    const xeroStatus = await xeroService.getConnectionStatus(organization.id);

    return {
      integrations: integrations.map((i) => ({
        type: i.type,
        isActive: i.isActive,
        config: maskIntegrationConfig(i.config as Record<string, unknown>),
        updatedAt: i.updatedAt,
      })),
      xeroStatus,
      schemas: INTEGRATION_FIELDS,
    };
  });

  app.get("/api/organizations/:idOrSlug/xero/contacts", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const status = await xeroService.getConnectionStatus(organization.id);
    if (!status.connected) {
      return reply.code(400).send({
        error: "Xero not connected",
        hint: "Go to Integrations → Connect Xero first",
      });
    }

    const contacts = await xeroService.listContacts(organization.id);
    return { contacts, tenantId: status.tenantId };
  });

  app.get("/api/organizations/:idOrSlug/integrations/xero/connect", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    try {
      const xeroConfig = await integrationConfigService.getXero(organization.id);
      const authUrl = await xeroService.getAuthUrl(organization.id, organization.slug);
      return {
        authUrl,
        redirectUri: xeroConfig.redirectUri,
        clientId: xeroConfig.clientId,
        setupChecklist: [
          "Open https://developer.xero.com/app/manage and select your app",
          `Add this exact Redirect URI: ${xeroConfig.redirectUri}`,
          "Ensure Client ID in Admin matches the Xero app Client ID",
          "Click Save on the Xero form below before connecting",
        ],
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Xero OAuth not configured",
        hint: "Save Client ID, Client Secret, and Redirect URI in the Xero integration form first.",
      });
    }
  });

  app.put("/api/organizations/:idOrSlug/integrations/:type", async (request, reply) => {
    const { idOrSlug, type } = request.params as { idOrSlug: string; type: string };
    const body = request.body as Record<string, unknown>;

    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const integrationType = type.toUpperCase() as IntegrationType;
    if (!Object.values(IntegrationType).includes(integrationType)) {
      return reply.code(400).send({ error: "Invalid integration type" });
    }

    const existing = await organizationService.getIntegration(organization.id, integrationType);
    const merged = mergeIntegrationConfig(
      (existing?.config ?? {}) as Record<string, unknown>,
      body
    );

    const integration = await organizationService.setIntegration(
      organization.id,
      integrationType,
      merged
    );

    return {
      ...integration,
      config: maskIntegrationConfig(integration.config as Record<string, unknown>),
    };
  });

  app.get("/api/organizations/:idOrSlug/workflows", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    return prisma.workflowRun.findMany({
      where: { organizationId: organization.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        type: true,
        status: true,
        currentStep: true,
        triggerRef: true,
        createdAt: true,
        completedAt: true,
      },
    });
  });

  app.get("/api/organizations/:idOrSlug/audit", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    return prisma.auditLogEntry.findMany({
      where: { organizationId: organization.id },
      orderBy: { timestampUtc: "desc" },
      take: 50,
      select: {
        id: true,
        actor: true,
        sourceChannel: true,
        triggerEvent: true,
        outcome: true,
        timestampUtc: true,
      },
    });
  });

  app.post("/api/organizations/:idOrSlug/test/po-intake", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const body = request.body as { message: string; from?: string };

    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    await enqueueJob("whatsapp.message", {
      messageId: `test-${Date.now()}`,
      from: body.from ?? "+919829173307",
      timestamp: new Date().toISOString(),
      type: "text",
      text: body.message,
      isGroup: false,
      organizationId: organization.id,
    });

    return { queued: true, organizationId: organization.id };
  });

  app.post("/api/organizations/:idOrSlug/test/whatsapp-webhook", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const body = request.body as { message?: string; from?: string };

    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const supervisorPhone = await organizationService.getSupervisorPhone(organization.id);
    if (!supervisorPhone) {
      return reply.code(400).send({
        error: "No supervisor configured",
        hint: "Add a team member with SUPERVISOR role first",
      });
    }

    const waIntegration = await organizationService.getIntegration(
      organization.id,
      IntegrationType.WHATSAPP
    );
    const waConfig = (waIntegration?.config ?? {}) as {
      phoneNumberId?: string;
      businessAccountId?: string;
    };

    const from = body.from ?? supervisorPhone;
    const message = body.message ?? "- Bok choy: 10 kg\n- Zucchini: 40 kg";
    const messageId = `wamid.admin-test-${Date.now()}`;

    const payload = buildTestWebhookPayload({
      message,
      from,
      phoneNumberId: waConfig.phoneNumberId,
      businessAccountId: waConfig.businessAccountId,
      messageId,
    });

    const result = await processWhatsAppWebhook(payload);

    return {
      ...result,
      messageId,
      from: from.startsWith("+") ? from : `+${from}`,
      organizationId: organization.id,
    };
  });
}
