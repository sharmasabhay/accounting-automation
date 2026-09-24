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
import { withOrganization } from "../../context/tenant.js";
import { logger } from "../../utils/logger.js";
import { invoiceCaptureWorkflow } from "../../workflows/invoice-capture/index.js";
import { reconciliationWorkflow } from "../../workflows/reconciliation/index.js";
import { paymentExecutionWorkflow } from "../../workflows/payment-execution/index.js";
import { dbsPlaywrightService } from "../../services/dbs-playwright.service.js";
import { skuMappingService } from "../../services/sku-mapping.service.js";
import { conversationService } from "../../services/conversation.service.js";
import { whatsappService } from "../../services/whatsapp.service.js";
import { orchestrator } from "../../orchestrator/router.js";
import { saveUploadedFile } from "../../utils/storage.js";
import { readInvoiceUploadRequest } from "../../utils/invoice-upload.js";
import { isSoaDocument } from "../../utils/matching.js";
import type { SavedEmailAttachment } from "../../types/index.js";

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
    merged[key] =
      SENSITIVE_KEYS.has(key) && typeof value === "string" ? value.replace(/\s+/g, "") : value;
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
        include: { skuMappings: { orderBy: { supplierItemName: "asc" } } },
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
      logger.error({ err, url: request.url }, "Supplier update failed");
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

  app.post("/api/organizations/:idOrSlug/suppliers/import-xero", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const body = (request.body ?? {}) as { contactIds?: string[] };
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
    const wanted = new Set((body.contactIds ?? []).map((id) => id.trim()).filter(Boolean));
    const selected = wanted.size
      ? contacts.filter((contact) => wanted.has(contact.contactId))
      : contacts;

    if (wanted.size && selected.length === 0) {
      return reply.code(404).send({ error: "No matching Xero supplier contacts" });
    }

    const result = await organizationService.importSuppliersFromXero(organization.id, selected);
    return {
      ok: true,
      tenantId: status.tenantId,
      imported: selected.length,
      created: result.created.length,
      updated: result.updated.length,
      createdNames: result.created,
      updatedNames: result.updated,
    };
  });

  async function requireSupplier(organizationId: string, supplierId: string) {
    return prisma.supplier.findFirst({
      where: { id: supplierId, organizationId, isActive: true },
    });
  }

  app.get(
    "/api/organizations/:idOrSlug/suppliers/:supplierId/sku-mappings",
    async (request, reply) => {
      const { idOrSlug, supplierId } = request.params as {
        idOrSlug: string;
        supplierId: string;
      };
      const organization = await organizationService.getByIdOrSlug(idOrSlug);
      if (!organization) {
        return reply.code(404).send({ error: "Organization not found" });
      }
      const supplier = await requireSupplier(organization.id, supplierId);
      if (!supplier) {
        return reply.code(404).send({ error: "Supplier not found" });
      }
      return skuMappingService.list(supplier.id);
    }
  );

  app.post(
    "/api/organizations/:idOrSlug/suppliers/:supplierId/sku-mappings",
    async (request, reply) => {
      const { idOrSlug, supplierId } = request.params as {
        idOrSlug: string;
        supplierId: string;
      };
      const body = request.body as {
        supplierItemName?: string;
        xeroItemId?: string;
        xeroItemCode?: string;
      };
      const organization = await organizationService.getByIdOrSlug(idOrSlug);
      if (!organization) {
        return reply.code(404).send({ error: "Organization not found" });
      }
      const supplier = await requireSupplier(organization.id, supplierId);
      if (!supplier) {
        return reply.code(404).send({ error: "Supplier not found" });
      }

      const supplierItemName = body.supplierItemName?.trim();
      const xeroItemCode = body.xeroItemCode?.trim();
      const xeroItemId = body.xeroItemId?.trim() || xeroItemCode;
      if (!supplierItemName || !xeroItemId) {
        return reply.code(400).send({
          error: "supplierItemName and xeroItemCode (or xeroItemId) are required",
        });
      }

      const mapping = await skuMappingService.confirm({
        supplierId: supplier.id,
        supplierItemName,
        xeroItemId,
        xeroItemCode: xeroItemCode || xeroItemId,
        confirmedBy: "admin",
      });
      return reply.code(201).send(mapping);
    }
  );

  app.delete(
    "/api/organizations/:idOrSlug/suppliers/:supplierId/sku-mappings/:mappingId",
    async (request, reply) => {
      const { idOrSlug, supplierId, mappingId } = request.params as {
        idOrSlug: string;
        supplierId: string;
        mappingId: string;
      };
      const organization = await organizationService.getByIdOrSlug(idOrSlug);
      if (!organization) {
        return reply.code(404).send({ error: "Organization not found" });
      }
      const supplier = await requireSupplier(organization.id, supplierId);
      if (!supplier) {
        return reply.code(404).send({ error: "Supplier not found" });
      }
      const deleted = await skuMappingService.remove(supplier.id, mappingId);
      if (!deleted) {
        return reply.code(404).send({ error: "SKU mapping not found" });
      }
      return { ok: true, id: deleted.id };
    }
  );

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

  app.get("/api/organizations/:idOrSlug/xero/items", async (request, reply) => {
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

    try {
      const items = await xeroService.listItems(organization.id);
      return { items, tenantId: status.tenantId };
    } catch (error) {
      logger.error({ err: error, url: request.url }, "Failed to load Xero items");
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Failed to load Xero items",
        hint: "Reconnect Xero in Integrations so the token includes accounting.settings (Items) access.",
      });
    }
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
      logger.error({ err: error, url: request.url }, "Xero OAuth connect URL failed");
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

  app.get("/api/organizations/:idOrSlug/purchase-orders", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const orders = await prisma.purchaseOrder.findMany({
      where: {
        supplier: { organizationId: organization.id },
        status: { in: ["SUBMITTED", "AUTHORISED"] },
      },
      include: {
        supplier: { select: { id: true, name: true, emailDomain: true } },
        lines: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return orders.map((po) => ({
      id: po.id,
      status: po.status,
      xeroPoNumber: po.xeroPoNumber,
      totalAmount: po.totalAmount != null ? Number(po.totalAmount) : null,
      createdAt: po.createdAt,
      supplier: po.supplier,
      lines: po.lines.map((line) => ({
        itemName: line.itemName,
        quantity: Number(line.quantity),
        unit: line.unit,
        unitPrice: line.unitPrice != null ? Number(line.unitPrice) : null,
        lineAmount: line.lineAmount != null ? Number(line.lineAmount) : null,
      })),
    }));
  });

  app.get("/api/organizations/:idOrSlug/conversations", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }
    return conversationService.list(organization.id);
  });

  app.delete("/api/organizations/:idOrSlug/conversations", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }
    const deleted = await conversationService.clear(organization.id);
    return { ok: true, deleted };
  });

  app.post("/api/organizations/:idOrSlug/conversations/reply", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const body = request.body as {
      channel?: "supervisor" | "supplier";
      message?: string;
      supplierId?: string;
    };

    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const message = body.message?.trim();
    if (!message) {
      return reply.code(400).send({ error: "message is required" });
    }

    const channel = body.channel === "supplier" ? "supplier" : "supervisor";
    const waIntegration = await organizationService.getIntegration(
      organization.id,
      IntegrationType.WHATSAPP
    );
    const waConfig = (waIntegration?.config ?? {}) as {
      phoneNumberId?: string;
      businessAccountId?: string;
    };

    let from: string;
    let isGroup = false;
    let groupId: string | undefined;
    let text = message;

    if (channel === "supplier") {
      const suppliers = await prisma.supplier.findMany({
        where: { organizationId: organization.id, isActive: true },
        orderBy: { name: "asc" },
      });
      const supplier =
        suppliers.find((s) => s.id === body.supplierId) ?? suppliers[0] ?? null;
      if (!supplier) {
        return reply.code(400).send({
          error: "No supplier configured",
          hint: "Add a supplier first, then send from the Supplier ↔ Bot box",
        });
      }
      isGroup = true;
      groupId = supplier.whatsappGroupId || `group:${supplier.id}`;
      from = groupId;
      if (!text.toLowerCase().includes("@bot")) {
        text = `@bot ${text}`;
      }
    } else {
      const supervisorPhone = await organizationService.getSupervisorPhone(organization.id);
      if (!supervisorPhone) {
        return reply.code(400).send({
          error: "No supervisor configured",
          hint: "Add a team member with SUPERVISOR role first",
        });
      }
      from = supervisorPhone;
    }

    const messageId = `wamid.admin-chat-${Date.now()}`;
    const payload = buildTestWebhookPayload({
      message: text,
      from,
      phoneNumberId: waConfig.phoneNumberId,
      businessAccountId: waConfig.businessAccountId,
      messageId,
      isGroup,
      groupId,
      organizationId: organization.id,
    });

    const result = await processWhatsAppWebhook(payload);
    return {
      ...result,
      messageId,
      channel,
      from,
      groupId,
      text,
    };
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

  app.post("/api/organizations/:idOrSlug/test/reset-operational", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) {
      return reply.code(404).send({ error: "Organization not found" });
    }

    const deleted = await organizationService.resetOperationalData(organization.id);
    const conversations = await conversationService.clear(organization.id);
    return { ok: true, organizationId: organization.id, deleted: { ...deleted, conversations } };
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
    const extra = body as {
      isGroup?: boolean;
      groupId?: string;
      type?: "text" | "image" | "document";
      filename?: string;
    };

    const payload = buildTestWebhookPayload({
      message,
      from,
      phoneNumberId: waConfig.phoneNumberId,
      businessAccountId: waConfig.businessAccountId,
      messageId,
      isGroup: extra.isGroup,
      groupId: extra.groupId,
      type: extra.type,
      filename: extra.filename,
      organizationId: organization.id,
    });

    const result = await processWhatsAppWebhook(payload);

    return {
      ...result,
      messageId,
      from: from.startsWith("+") ? from : `+${from}`,
      organizationId: organization.id,
    };
  });

  app.post("/api/organizations/:idOrSlug/test/invoice", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) return reply.code(404).send({ error: "Organization not found" });
    const supervisorPhone = await organizationService.getSupervisorPhone(organization.id);
    if (!supervisorPhone) {
      return reply.code(400).send({ error: "No supervisor configured" });
    }

    let files;
    try {
      files = (await readInvoiceUploadRequest(request)).files;
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid invoice file",
      });
    }

    const prepared = await withOrganization(organization.id, async () => {
      const runs: Array<{
        workflowRunId: string;
        filename: string;
        filePath: string;
        mimeType: string;
        triggerRef: string;
      }> = [];
      for (const file of files) {
        const filePath = await saveUploadedFile(file.content, file.filename, organization.id);
        const triggerRef = `admin-invoice-${Date.now()}-${file.filename}`;
        const run = await prisma.workflowRun.create({
          data: {
            organizationId: organization.id,
            type: "INVOICE_CAPTURE",
            triggerRef,
            status: "IN_PROGRESS",
          },
        });
        await conversationService.recordInbound(organization.id, {
          messageId: triggerRef,
          from: supervisorPhone,
          timestamp: String(Date.now()),
          type: file.mimeType === "application/pdf" ? "document" : "image",
          filename: file.filename,
          mimeType: file.mimeType,
          isGroup: false,
          organizationId: organization.id,
        });
        runs.push({
          workflowRunId: run.id,
          filename: file.filename,
          filePath,
          mimeType: file.mimeType,
          triggerRef,
        });
      }
      await whatsappService.sendText(
        supervisorPhone,
        `Reading ${runs.length === 1 ? runs[0]!.filename : `${runs.length} invoices`} with local OCR — this uses the file you uploaded, not sample data.`
      );
      return runs;
    });

    await withOrganization(organization.id, async () => {
      for (const run of prepared) {
        await invoiceCaptureWorkflow.processInvoice(
          run.workflowRunId,
          run.filePath,
          "WHATSAPP",
          run.triggerRef,
          supervisorPhone,
          run.mimeType
        );
      }
    });

    return {
      queued: true,
      processed: true,
      source: "WHATSAPP",
      runs: prepared.map(({ workflowRunId, filename }) => ({ workflowRunId, filename })),
    };
  });

  app.post("/api/organizations/:idOrSlug/test/email-scan", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) return reply.code(404).send({ error: "Organization not found" });

    let files;
    let fields: Record<string, string>;
    try {
      ({ files, fields } = await readInvoiceUploadRequest(request));
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid invoice file",
      });
    }

    const supplier = await prisma.supplier.findFirst({
      where: {
        organizationId: organization.id,
        isActive: true,
        ...(fields.from ? {} : { emailDomain: { not: null } }),
      },
    });
    const from = fields.from || (supplier?.emailDomain ? `ap@${supplier.emailDomain}` : "");
    if (!from || !from.includes("@")) {
      return reply.code(400).send({
        error: "Set a From address whose domain matches a supplier Email domain",
      });
    }

    const subject = fields.subject || "Invoice";
    const kind = fields.kind === "soa" ? "soa" : "invoice";
    const messageId = `admin-email-${Date.now()}`;

    return withOrganization(organization.id, async () => {
      const attachments: SavedEmailAttachment[] = [];
      for (const file of files) {
        const filePath = await saveUploadedFile(file.content, file.filename, organization.id);
        attachments.push({
          filePath,
          filename: file.filename,
          contentType: file.mimeType,
          from,
          subject,
          messageId,
          kind: kind === "soa" || isSoaDocument(file.filename, subject) ? "soa" : "invoice",
        });
      }
      await enqueueJob("email.scan", {
        scheduledAt: new Date().toISOString(),
        organizationId: organization.id,
        attachments,
      });
      return { queued: true, source: "EMAIL", from, attachments: attachments.length };
    });
  });

  app.post("/api/organizations/:idOrSlug/test/email-inbox", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) return reply.code(404).send({ error: "Organization not found" });

    const email = await integrationConfigService.getEmail(organization.id);
    if (!integrationConfigService.isEmailConfigured(email)) {
      return reply.code(400).send({
        error:
          "Email IMAP is not configured. In Admin → Integrations → EMAIL set IMAP host, username, and app password, then save.",
      });
    }

    try {
      const result = await orchestrator.scanEmailInboxNow(organization.id);
      return {
        source: "EMAIL_IMAP",
        mailbox: email.imapUser,
        host: email.imapHost,
        ...result,
      };
    } catch (error) {
      logger.error({ err: error, organizationId: organization.id }, "Live IMAP scan failed");
      return reply.code(502).send({
        error: error instanceof Error ? error.message : "IMAP inbox scan failed",
      });
    }
  });

  app.post("/api/organizations/:idOrSlug/test/reconcile", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const body = request.body as { message?: string; from?: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) return reply.code(404).send({ error: "Organization not found" });
    const supervisorPhone =
      body.from ?? (await organizationService.getSupervisorPhone(organization.id));
    if (!supervisorPhone) {
      return reply.code(400).send({ error: "No supervisor configured" });
    }

    return withOrganization(organization.id, async () => {
      const run = await prisma.workflowRun.create({
        data: {
          organizationId: organization.id,
          type: "RECONCILIATION",
          triggerRef: `admin-recon-${Date.now()}`,
          status: "IN_PROGRESS",
        },
      });
      await reconciliationWorkflow.startFromDm(run.id, {
        messageId: run.triggerRef ?? run.id,
        from: supervisorPhone,
        timestamp: String(Date.now()),
        type: "text",
        text: body.message ?? "Please reconcile payment for Fresh Farms",
        isGroup: false,
        organizationId: organization.id,
      });
      return { queued: true, workflowRunId: run.id };
    });
  });

  app.post("/api/organizations/:idOrSlug/test/dbs-approve", async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const body = request.body as { transactionRef?: string };
    const organization = await organizationService.getByIdOrSlug(idOrSlug);
    if (!organization) return reply.code(404).send({ error: "Organization not found" });

    const requestedRef = body.transactionRef?.trim().replaceAll("_", "-") || undefined;
    const batch = requestedRef
      ? await prisma.paymentBatch.findFirst({
          where: { dbsTransactionRef: requestedRef, supplier: { organizationId: organization.id } },
        })
      : await prisma.paymentBatch.findFirst({
          where: {
            status: "AWAITING_BANK_APPROVAL",
            supplier: { organizationId: organization.id },
          },
          orderBy: { createdAt: "desc" },
        });

    if (!batch?.dbsTransactionRef) {
      return reply.code(404).send({
        error: requestedRef
          ? `No payment batch found for "${requestedRef}". Leave the field blank to use the latest, or paste the exact DRY-DBS-… ref from the supervisor message after you reply ready.`
          : 'No payment is waiting for bank approval yet. Finish reconcile, then in Supervisor chat reply "ready". After that, leave this field blank and click Simulate DBS approved.',
      });
    }

    if (batch.status !== "AWAITING_BANK_APPROVAL") {
      return reply.code(400).send({
        error: `This batch is "${batch.status}", not awaiting bank approval. Reply "ready" in Supervisor chat first, then simulate approval.`,
      });
    }

    dbsPlaywrightService.simulateApproval(batch.dbsTransactionRef);
    await withOrganization(organization.id, () => paymentExecutionWorkflow.monitorApprovals());
    await enqueueJob("payment.monitor", {
      scheduledAt: new Date().toISOString(),
      organizationId: organization.id,
    });
    return { queued: true, transactionRef: batch.dbsTransactionRef };
  });
}
