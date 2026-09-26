import { IntegrationType, Prisma, TeamMemberRole, type Organization } from "@prisma/client";
import { prisma } from "../db/client.js";
import type { WhatsAppInboundMessage } from "../types/index.js";

function optionalText(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function mapSupplierWriteError(error: unknown): Error {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const fields = error.meta?.target;
    const target = Array.isArray(fields) ? fields.join(",") : String(fields ?? "");
    if (target.includes("whatsapp_group_id") || target.includes("whatsappGroupId")) {
      return new Error(
        "This WhatsApp group is already linked to another supplier. Leave the group ID blank unless this supplier has its own group."
      );
    }
    return new Error("A supplier with these details already exists.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  timezone?: string;
  settings?: Record<string, unknown>;
}

export interface CreateTeamMemberInput {
  name: string;
  phoneNumber: string;
  role?: TeamMemberRole;
}

export interface CreateSupplierInput {
  name: string;
  emailDomain?: string | null;
  xeroContactId?: string | null;
  whatsappGroupId?: string | null;
  dbsPayeeName?: string | null;
}

export interface UpdateSupplierInput {
  name?: string;
  emailDomain?: string | null;
  xeroContactId?: string | null;
  whatsappGroupId?: string | null;
  dbsPayeeName?: string | null;
}

function normalizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
}

function normalizePhone(phone: string): string {
  return phone.startsWith("+") ? phone : `+${phone}`;
}

class OrganizationService {
  async create(input: CreateOrganizationInput): Promise<Organization> {
    const slug = normalizeSlug(input.slug);

    return prisma.organization.create({
      data: {
        name: input.name,
        slug,
        timezone: input.timezone ?? "Asia/Singapore",
        settings: (input.settings ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async list(): Promise<Organization[]> {
    return prisma.organization.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });
  }

  async getByIdOrSlug(idOrSlug: string): Promise<Organization | null> {
    return prisma.organization.findFirst({
      where: {
        isActive: true,
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      },
    });
  }

  async addTeamMember(organizationId: string, input: CreateTeamMemberInput) {
    return prisma.teamMember.create({
      data: {
        organizationId,
        name: input.name,
        phoneNumber: normalizePhone(input.phoneNumber),
        role: input.role ?? TeamMemberRole.MEMBER,
      },
    });
  }

  async removeTeamMember(organizationId: string, memberId: string) {
    const member = await prisma.teamMember.findFirst({
      where: { id: memberId, organizationId, isActive: true },
    });

    if (!member) {
      return null;
    }

    return prisma.teamMember.update({
      where: { id: memberId },
      data: { isActive: false },
    });
  }

  async addSupplier(organizationId: string, input: CreateSupplierInput) {
    const name = input.name?.trim();
    if (!name) {
      throw new Error("Name is required");
    }

    const data = {
      name,
      emailDomain: optionalText(input.emailDomain) ?? null,
      xeroContactId: optionalText(input.xeroContactId) ?? null,
      whatsappGroupId: optionalText(input.whatsappGroupId) ?? null,
      dbsPayeeName: optionalText(input.dbsPayeeName) ?? null,
    };

    if (data.whatsappGroupId) {
      const existing = await prisma.supplier.findFirst({
        where: { organizationId, whatsappGroupId: data.whatsappGroupId },
      });
      if (existing?.isActive) {
        throw new Error(
          "This WhatsApp group is already linked to another supplier. Leave the group ID blank unless this supplier has its own group."
        );
      }
      if (existing) {
        return prisma.supplier.update({
          where: { id: existing.id },
          data: { ...data, isActive: true },
        });
      }
    }

    try {
      return await prisma.supplier.create({
        data: { organizationId, ...data },
      });
    } catch (error) {
      throw mapSupplierWriteError(error);
    }
  }

  async removeSupplier(organizationId: string, supplierId: string) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: supplierId, organizationId, isActive: true },
    });

    if (!supplier) {
      return null;
    }

    return prisma.supplier.update({
      where: { id: supplierId },
      data: { isActive: false, whatsappGroupId: null },
    });
  }

  async updateSupplier(
    organizationId: string,
    supplierId: string,
    input: UpdateSupplierInput
  ) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: supplierId, organizationId, isActive: true },
    });

    if (!supplier) {
      return null;
    }

    const data: Prisma.SupplierUpdateInput = {};

    if (input.name !== undefined) {
      const name = input.name?.trim() ?? "";
      if (!name) {
        throw new Error("Name is required");
      }
      data.name = name;
    }
    if (input.emailDomain !== undefined) {
      data.emailDomain = optionalText(input.emailDomain) ?? null;
    }
    if (input.xeroContactId !== undefined) {
      data.xeroContactId = optionalText(input.xeroContactId) ?? null;
    }
    if (input.whatsappGroupId !== undefined) {
      data.whatsappGroupId = optionalText(input.whatsappGroupId) ?? null;
    }
    if (input.dbsPayeeName !== undefined) {
      data.dbsPayeeName = optionalText(input.dbsPayeeName) ?? null;
    }

    try {
      return await prisma.supplier.update({
        where: { id: supplierId },
        data,
      });
    } catch (error) {
      throw mapSupplierWriteError(error);
    }
  }

  async importSuppliersFromXero(
    organizationId: string,
    contacts: Array<{ contactId: string; name: string; email?: string }>
  ): Promise<{ created: string[]; updated: string[] }> {
    const existing = await prisma.supplier.findMany({ where: { organizationId } });
    const created: string[] = [];
    const updated: string[] = [];

    for (const contact of contacts) {
      const name = contact.name.trim();
      const contactId = contact.contactId.trim();
      if (!name || !contactId) continue;

      const domain = contact.email?.includes("@")
        ? contact.email.split("@").pop()?.trim().toLowerCase()
        : undefined;

      const match =
        existing.find((supplier) => supplier.xeroContactId === contactId) ??
        existing.find(
          (supplier) =>
            !supplier.xeroContactId &&
            supplier.name.trim().toLowerCase() === name.toLowerCase()
        );

      if (match) {
        const saved = await prisma.supplier.update({
          where: { id: match.id },
          data: {
            name,
            xeroContactId: contactId,
            isActive: true,
            ...(domain ? { emailDomain: domain } : {}),
            ...(!match.dbsPayeeName ? { dbsPayeeName: name } : {}),
          },
        });
        Object.assign(match, saved);
        updated.push(name);
        continue;
      }

      const saved = await prisma.supplier.create({
        data: {
          organizationId,
          name,
          xeroContactId: contactId,
          emailDomain: domain || null,
          dbsPayeeName: name,
        },
      });
      existing.push(saved);
      created.push(name);
    }

    return { created, updated };
  }

  async resetOperationalData(organizationId: string): Promise<{
    purchaseOrders: number;
    skuMappings: number;
    workflowRuns: number;
  }> {
    const [purchaseOrders, skuMappings, workflowRuns] = await prisma.$transaction(async (tx) => {
      await tx.paymentBatch.deleteMany({
        where: { supplier: { organizationId } },
      });
      await tx.reconciliationRun.deleteMany({
        where: { supplier: { organizationId } },
      });
      await tx.xeroBill.deleteMany({
        where: { supplier: { organizationId } },
      });
      const poResult = await tx.purchaseOrder.deleteMany({
        where: { supplier: { organizationId } },
      });
      await tx.invoiceCandidate.deleteMany({
        where: { supplier: { organizationId } },
      });
      const skuResult = await tx.supplierSkuMapping.deleteMany({
        where: { supplier: { organizationId } },
      });
      await tx.followUpTask.deleteMany({
        where: { workflowRun: { organizationId } },
      });
      await tx.approvalRequest.deleteMany({
        where: { workflowRun: { organizationId } },
      });
      await tx.auditLogEntry.deleteMany({ where: { organizationId } });
      const wfResult = await tx.workflowRun.deleteMany({ where: { organizationId } });
      return [poResult.count, skuResult.count, wfResult.count] as const;
    });

    return { purchaseOrders, skuMappings, workflowRuns };
  }

  async setIntegration(
    organizationId: string,
    type: IntegrationType,
    config: Record<string, unknown>
  ) {
    return prisma.organizationIntegration.upsert({
      where: {
        organizationId_type: { organizationId, type },
      },
      create: {
        organizationId,
        type,
        config: config as Prisma.InputJsonValue,
      },
      update: {
        config: config as Prisma.InputJsonValue,
        isActive: true,
      },
    });
  }

  async getIntegration(organizationId: string, type: IntegrationType) {
    return prisma.organizationIntegration.findUnique({
      where: { organizationId_type: { organizationId, type } },
    });
  }

  async getSupervisorPhone(organizationId: string): Promise<string | null> {
    const supervisor = await prisma.teamMember.findFirst({
      where: {
        organizationId,
        role: TeamMemberRole.SUPERVISOR,
        isActive: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return supervisor?.phoneNumber ?? null;
  }

  /**
   * Resolve which organization owns an inbound WhatsApp message.
   * Priority: explicit orgId → tenant WhatsApp integration (phone_number_id / WABA id)
   * → team member phone → supplier group.
   *
   * The integration lookup comes first because with partner (Embedded Signup)
   * onboarding, every tenant has its own WABA/phone number — the receiving
   * number is authoritative for which tenant owns the message.
   */
  async resolveFromWhatsApp(
    message: WhatsAppInboundMessage
  ): Promise<Organization | null> {
    if (message.organizationId) {
      return this.getByIdOrSlug(message.organizationId);
    }

    if (message.whatsappPhoneNumberId || message.whatsappBusinessAccountId) {
      const byIntegration = await this.resolveByWhatsAppIntegration(
        message.whatsappPhoneNumberId,
        message.whatsappBusinessAccountId
      );
      if (byIntegration) {
        return byIntegration;
      }
    }

    const phone = normalizePhone(message.from);

    const member = await prisma.teamMember.findFirst({
      where: { phoneNumber: phone, isActive: true },
      include: { organization: true },
    });
    if (member?.organization.isActive) {
      return member.organization;
    }

    if (message.isGroup && message.groupId) {
      const supplier = await prisma.supplier.findFirst({
        where: { whatsappGroupId: message.groupId, isActive: true },
        include: { organization: true },
      });
      if (supplier?.organization.isActive) {
        return supplier.organization;
      }
    }

    return null;
  }

  private async resolveByWhatsAppIntegration(
    phoneNumberId?: string,
    businessAccountId?: string
  ): Promise<Organization | null> {
    const integrations = await prisma.organizationIntegration.findMany({
      where: { type: IntegrationType.WHATSAPP, isActive: true },
      include: { organization: true },
    });

    let wabaMatch: Organization | null = null;

    for (const integration of integrations) {
      if (!integration.organization.isActive) continue;

      const config = integration.config as {
        phoneNumberId?: string;
        businessAccountId?: string;
      };

      if (phoneNumberId && config.phoneNumberId === phoneNumberId) {
        return integration.organization;
      }
      if (businessAccountId && config.businessAccountId === businessAccountId) {
        wabaMatch = integration.organization;
      }
    }

    return wabaMatch;
  }

  async listActiveOrganizations(): Promise<Organization[]> {
    return prisma.organization.findMany({ where: { isActive: true } });
  }

  async update(
    organizationId: string,
    data: { name?: string; timezone?: string; isActive?: boolean; settings?: Record<string, unknown> }
  ): Promise<Organization> {
    return prisma.organization.update({
      where: { id: organizationId },
      data: {
        name: data.name,
        timezone: data.timezone,
        isActive: data.isActive,
        settings: data.settings as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async listIntegrations(organizationId: string) {
    return prisma.organizationIntegration.findMany({
      where: { organizationId },
      orderBy: { type: "asc" },
    });
  }
}

export const organizationService = new OrganizationService();
