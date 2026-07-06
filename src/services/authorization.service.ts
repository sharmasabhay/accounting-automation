import { TeamMemberRole } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getOrganizationId } from "../context/tenant.js";

class AuthorizationService {
  async isTeamMember(phoneNumber: string, organizationId?: string): Promise<boolean> {
    const orgId = organizationId ?? getOrganizationId();
    const member = await prisma.teamMember.findFirst({
      where: { organizationId: orgId, phoneNumber, isActive: true },
    });
    return Boolean(member);
  }

  async isSupervisor(phoneNumber: string, organizationId?: string): Promise<boolean> {
    const orgId = organizationId ?? getOrganizationId();
    const member = await prisma.teamMember.findFirst({
      where: {
        organizationId: orgId,
        phoneNumber,
        isActive: true,
        role: TeamMemberRole.SUPERVISOR,
      },
    });
    return Boolean(member);
  }

  async isWhitelistedEmailDomain(email: string, organizationId?: string): Promise<boolean> {
    const orgId = organizationId ?? getOrganizationId();
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return false;

    const supplier = await prisma.supplier.findFirst({
      where: { organizationId: orgId, emailDomain: domain, isActive: true },
    });
    return Boolean(supplier);
  }

  async getSupplierByEmailDomain(email: string, organizationId?: string) {
    const orgId = organizationId ?? getOrganizationId();
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return null;

    return prisma.supplier.findFirst({
      where: { organizationId: orgId, emailDomain: domain, isActive: true },
    });
  }

  async getSupplierByGroupId(groupId: string, organizationId?: string) {
    const orgId = organizationId ?? getOrganizationId();
    return prisma.supplier.findFirst({
      where: { organizationId: orgId, whatsappGroupId: groupId, isActive: true },
    });
  }

  async hasSavedPayee(supplierId: string): Promise<boolean> {
    const orgId = getOrganizationId();
    const supplier = await prisma.supplier.findFirst({
      where: { id: supplierId, organizationId: orgId },
    });
    return Boolean(supplier?.dbsPayeeName);
  }
}

export const authorizationService = new AuthorizationService();
