import { IntegrationType, TeamMemberRole, type Organization, type Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import type { WhatsAppInboundMessage } from "../types/index.js";

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
  emailDomain?: string;
  xeroContactId?: string;
  whatsappGroupId?: string;
  dbsPayeeName?: string;
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
    return prisma.supplier.create({
      data: {
        organizationId,
        name: input.name,
        emailDomain: input.emailDomain,
        xeroContactId: input.xeroContactId,
        whatsappGroupId: input.whatsappGroupId,
        dbsPayeeName: input.dbsPayeeName,
      },
    });
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
      data: { isActive: false },
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
      const name = input.name.trim();
      if (!name) {
        throw new Error("Name is required");
      }
      data.name = name;
    }
    if (input.emailDomain !== undefined) {
      data.emailDomain = input.emailDomain?.trim() || null;
    }
    if (input.xeroContactId !== undefined) {
      data.xeroContactId = input.xeroContactId?.trim() || null;
    }
    if (input.whatsappGroupId !== undefined) {
      data.whatsappGroupId = input.whatsappGroupId?.trim() || null;
    }
    if (input.dbsPayeeName !== undefined) {
      data.dbsPayeeName = input.dbsPayeeName?.trim() || null;
    }

    return prisma.supplier.update({
      where: { id: supplierId },
      data,
    });
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
