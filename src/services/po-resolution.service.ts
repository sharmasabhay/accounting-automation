import { prisma } from "../db/client.js";
import { namesMatch } from "../utils/matching.js";
import { skuMappingService } from "./sku-mapping.service.js";
import type { ParsedOrderItem } from "../types/index.js";

export interface ResolvedPoItem extends ParsedOrderItem {
  needsSkuConfirmation: boolean;
  needsPriceConfirmation: boolean;
}

class PoResolutionService {
  async resolveSupplier(options: {
    organizationId: string;
    mentionedName?: string;
    items: ParsedOrderItem[];
  }) {
    const { organizationId } = options;
    const suppliers = await prisma.supplier.findMany({
      where: { organizationId, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (suppliers.length === 0) return { supplier: null, ambiguous: false as const, inferredFromHistory: false as const };

    const mentioned =
      options.mentionedName ??
      options.items.map((item) => item.supplier).find((name) => Boolean(name));
    if (mentioned) {
      const exact = suppliers.find((s) => namesMatch(s.name, mentioned));
      if (exact) return { supplier: exact, ambiguous: false as const, inferredFromHistory: false as const };
      const partial = suppliers.filter(
        (s) =>
          s.name.toLowerCase().includes(mentioned.toLowerCase()) ||
          mentioned.toLowerCase().includes(s.name.toLowerCase())
      );
      if (partial.length === 1) {
        return { supplier: partial[0]!, ambiguous: false as const, inferredFromHistory: false as const };
      }
      if (partial.length > 1) {
        return { supplier: null, ambiguous: true as const, inferredFromHistory: false as const };
      }
    }

    const votes = new Map<string, number>();
    for (const item of options.items) {
      const line = await prisma.purchaseOrderLine.findFirst({
        where: {
          itemName: { contains: item.itemName, mode: "insensitive" },
          purchaseOrder: { supplier: { organizationId, isActive: true } },
        },
        orderBy: { purchaseOrder: { createdAt: "desc" } },
        include: { purchaseOrder: { include: { supplier: true } } },
      });
      if (!line) continue;
      votes.set(line.purchaseOrder.supplierId, (votes.get(line.purchaseOrder.supplierId) ?? 0) + 1);
    }

    if (votes.size === 1) {
      const supplierId = [...votes.keys()][0]!;
      const supplier = suppliers.find((s) => s.id === supplierId) ?? null;
      return { supplier, ambiguous: false as const, inferredFromHistory: true as const };
    }
    if (votes.size > 1) {
      return { supplier: null, ambiguous: true as const, inferredFromHistory: false as const };
    }

    if (suppliers.length === 1) {
      return { supplier: suppliers[0]!, ambiguous: false as const, inferredFromHistory: false as const };
    }

    return { supplier: null, ambiguous: true as const, inferredFromHistory: false as const };
  }

  async lastPrice(supplierId: string, itemName: string): Promise<number | null> {
    const line = await prisma.purchaseOrderLine.findFirst({
      where: {
        purchaseOrder: { supplierId },
        itemName: { contains: itemName, mode: "insensitive" },
        unitPrice: { not: null },
      },
      orderBy: { purchaseOrder: { createdAt: "desc" } },
    });
    return line?.unitPrice != null ? Number(line.unitPrice) : null;
  }

  async enrichItems(
    organizationId: string,
    supplierId: string,
    items: ParsedOrderItem[]
  ): Promise<ResolvedPoItem[]> {
    const resolved: ResolvedPoItem[] = [];
    for (const item of items) {
      const sku = await skuMappingService.resolveItem(organizationId, supplierId, item.itemName);
      const historyPrice = await this.lastPrice(supplierId, item.itemName);
      const xeroPrice = sku.item?.purchaseUnitPrice;
      const unitPrice = historyPrice ?? xeroPrice ?? item.unitPrice;
      resolved.push({
        ...item,
        xeroItemId: sku.item?.itemId ?? item.xeroItemId,
        xeroItemCode: sku.item?.code ?? item.xeroItemCode,
        unitPrice,
        priceSource:
          historyPrice != null
            ? "history"
            : xeroPrice != null
              ? "xero"
              : item.unitPrice != null
                ? "confirmed"
                : "unknown",
        needsSkuConfirmation: sku.needsConfirmation || sku.ambiguous,
        needsPriceConfirmation: unitPrice == null,
      });
    }
    return resolved;
  }
}

export const poResolutionService = new PoResolutionService();
