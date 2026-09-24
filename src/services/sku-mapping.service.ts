import { prisma } from "../db/client.js";
import { catalogItemMatches, namesMatch, normalizeItemName } from "../utils/matching.js";
import { xeroService } from "./xero.service.js";
import type { XeroItem } from "../types/index.js";

class SkuMappingService {
  async list(supplierId: string) {
    return prisma.supplierSkuMapping.findMany({
      where: { supplierId },
      orderBy: { supplierItemName: "asc" },
    });
  }

  async remove(supplierId: string, mappingId: string) {
    const existing = await prisma.supplierSkuMapping.findFirst({
      where: { id: mappingId, supplierId },
    });
    if (!existing) return null;
    await prisma.supplierSkuMapping.delete({ where: { id: mappingId } });
    return existing;
  }

  async applySupervisorCode(
    organizationId: string,
    supplierId: string,
    supplierItemName: string,
    answer: string,
    confirmedBy?: string
  ): Promise<{ itemId: string; code: string }> {
    const code = answer.trim();
    const catalog = await xeroService.listItems(organizationId);
    const matches = this.matchCatalog(code, catalog);
    const chosen = matches[0];
    const itemId = chosen?.itemId ?? code;
    const itemCode = chosen?.code ?? code;
    await this.confirm({
      supplierId,
      supplierItemName,
      xeroItemId: itemId,
      xeroItemCode: itemCode,
      confirmedBy,
    });
    return { itemId, code: itemCode };
  }

  async find(supplierId: string, supplierItemName: string) {
    const needle = normalizeItemName(supplierItemName);
    const mappings = await prisma.supplierSkuMapping.findMany({ where: { supplierId } });
    return (
      mappings.find((mapping) => normalizeItemName(mapping.supplierItemName) === needle) ??
      mappings.find((mapping) => namesMatch(mapping.supplierItemName, supplierItemName)) ??
      null
    );
  }

  async confirm(input: {
    supplierId: string;
    supplierItemName: string;
    xeroItemId: string;
    xeroItemCode?: string;
    confirmedBy?: string;
  }) {
    return prisma.supplierSkuMapping.upsert({
      where: {
        supplierId_supplierItemName: {
          supplierId: input.supplierId,
          supplierItemName: input.supplierItemName.trim(),
        },
      },
      create: {
        supplierId: input.supplierId,
        supplierItemName: input.supplierItemName.trim(),
        xeroItemId: input.xeroItemId,
        xeroItemCode: input.xeroItemCode,
        confirmedBy: input.confirmedBy,
      },
      update: {
        xeroItemId: input.xeroItemId,
        xeroItemCode: input.xeroItemCode,
        confirmedBy: input.confirmedBy,
      },
    });
  }

  matchCatalog(name: string, catalog: XeroItem[]): XeroItem[] {
    return catalog.filter(
      (item) => catalogItemMatches(name, item.name, item.code) || namesMatch(item.code, name)
    );
  }

  async resolveItem(
    organizationId: string,
    supplierId: string,
    itemName: string
  ): Promise<{ item?: XeroItem; ambiguous: boolean; needsConfirmation: boolean }> {
    const mapped = await this.find(supplierId, itemName);
    if (mapped) {
      return {
        item: {
          itemId: mapped.xeroItemId,
          code: mapped.xeroItemCode ?? mapped.xeroItemId,
          name: itemName,
        },
        ambiguous: false,
        needsConfirmation: false,
      };
    }

    const catalog = await xeroService.listItems(organizationId);
    if (catalog.length === 0) {
      return { ambiguous: false, needsConfirmation: true };
    }

    const matches = this.matchCatalog(itemName, catalog);
    if (matches.length === 1) {
      const item = matches[0]!;
      await this.confirm({
        supplierId,
        supplierItemName: itemName,
        xeroItemId: item.itemId,
        xeroItemCode: item.code,
        confirmedBy: "xero-catalog",
      });
      return { item, ambiguous: false, needsConfirmation: false };
    }
    if (matches.length > 1) {
      return { ambiguous: true, needsConfirmation: true };
    }
    return { needsConfirmation: true, ambiguous: false };
  }
}

export const skuMappingService = new SkuMappingService();
