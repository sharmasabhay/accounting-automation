import { TeamMemberRole } from "@prisma/client";
import { prisma } from "../src/db/client.js";
import { organizationService } from "../src/services/organization.service.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
  logger.info("Seeding database...");

  const demoOrg = await prisma.organization.upsert({
    where: { slug: "omakase-demo" },
    update: {},
    create: {
      name: "Omakase Demo",
      slug: "omakase-demo",
      timezone: "Asia/Singapore",
      settings: { dryRun: true },
    },
  });

  await prisma.teamMember.upsert({
    where: {
      organizationId_phoneNumber: {
        organizationId: demoOrg.id,
        phoneNumber: "+6590000000",
      },
    },
    update: {},
    create: {
      organizationId: demoOrg.id,
      name: "Supervisor",
      phoneNumber: "+6590000000",
      role: TeamMemberRole.SUPERVISOR,
    },
  });

  const suppliers = [
    {
      name: "Fresh Farms Pte Ltd",
      emailDomain: "freshfarms.com.sg",
      whatsappGroupId: "fresh-farms-group",
      dbsPayeeName: "FRESH FARMS PTE LTD",
    },
    {
      name: "Ocean Harvest Seafood",
      emailDomain: "oceanharvest.com.sg",
      whatsappGroupId: "ocean-harvest-group",
      dbsPayeeName: "OCEAN HARVEST SEAFOOD",
    },
  ];

  for (const supplier of suppliers) {
    const existing = await prisma.supplier.findFirst({
      where: { organizationId: demoOrg.id, name: supplier.name },
    });

    if (!existing) {
      await organizationService.addSupplier(demoOrg.id, supplier);
    }
  }

  // Second demo organization to illustrate multi-tenancy
  const acmeOrg = await prisma.organization.upsert({
    where: { slug: "acme-foods" },
    update: {},
    create: {
      name: "Acme Foods Pte Ltd",
      slug: "acme-foods",
      timezone: "Asia/Singapore",
    },
  });

  await prisma.teamMember.upsert({
    where: {
      organizationId_phoneNumber: {
        organizationId: acmeOrg.id,
        phoneNumber: "+6591111111",
      },
    },
    update: {},
    create: {
      organizationId: acmeOrg.id,
      name: "Acme Supervisor",
      phoneNumber: "+6591111111",
      role: TeamMemberRole.SUPERVISOR,
    },
  });

  logger.info({ organizations: ["omakase-demo", "acme-foods"] }, "Seed completed.");
}

main()
  .catch((error) => {
    logger.error({ error }, "Seed failed");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
