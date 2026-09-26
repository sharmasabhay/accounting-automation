import { WorkflowStatus, ApprovalGateType } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getOrganizationId } from "../../context/tenant.js";
import { llmService } from "../../services/llm.service.js";
import { xeroService } from "../../services/xero.service.js";
import { whatsappService } from "../../services/whatsapp.service.js";
import { approvalService } from "../../services/approval.service.js";
import { authorizationService } from "../../services/authorization.service.js";
import { organizationService } from "../../services/organization.service.js";
import { auditService } from "../../services/audit.service.js";
import { poResolutionService, type ResolvedPoItem } from "../../services/po-resolution.service.js";
import { skuMappingService } from "../../services/sku-mapping.service.js";
import { BOT_HELP_GUIDE } from "../../prompts/system.js";
import { logger } from "../../utils/logger.js";
import { logDone, logStep } from "../../utils/workflow-log.js";
import { parsePoModification, looksLikeSupplierChange, isRestartCommand, isAffirmativeReply, parsePoItemDetailsReply, namesMatch, suggestedItemCode } from "../../utils/matching.js";
import { isXeroError, notifySupervisorOfXeroError } from "../../utils/xero-error.js";
import type { ParsedOrderItem, WhatsAppInboundMessage } from "../../types/index.js";

interface PoDraftPayload {
  items: ResolvedPoItem[];
  supplierId?: string;
  supplierName?: string;
  supplierConfirmed?: boolean;
  inferredFromHistory?: boolean;
  messageId: string;
  from: string;
  originalText: string;
  pendingGate?: string;
  localPoId?: string;
}

const HELP_PATTERNS =
  /^(help|hi|hello|hey|menu|guide|how\b|what can you|commands?\b|start\b|thanks?\b|thank you|ok\b|okay\b|\?+)$/i;

function looksLikeHelpRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (HELP_PATTERNS.test(trimmed)) return true;
  if (/^(help|guide|how do|how to|what do you)\b/i.test(trimmed)) return true;
  return false;
}

function pendingItemDetails(items: ResolvedPoItem[]): ResolvedPoItem[] {
  return items.filter((item) => item.needsSkuConfirmation || item.needsPriceConfirmation);
}

function buildItemDetailsQuestion(supplierName: string, items: ResolvedPoItem[]): string {
  const pending = pendingItemDetails(items);
  const examples = pending.map((item) => {
    const code = item.xeroItemCode && item.xeroItemCode !== item.itemName
      ? item.xeroItemCode
      : suggestedItemCode(item.itemName);
    return `${item.itemName}: ${code} 3.50`;
  });
  const rows = pending.map((item) => {
    const qty = `${item.quantity}${item.unit ? ` ${item.unit}` : ""}`;
    if (item.needsSkuConfirmation && item.needsPriceConfirmation) {
      return `• ${item.itemName} (${qty}) — new item, needs Xero code and unit price`;
    }
    if (item.needsSkuConfirmation) {
      return `• ${item.itemName} (${qty}) — needs Xero item code`;
    }
    return `• ${item.itemName} (${qty}) — needs unit price in SGD`;
  });
  return [
    `These items are not fully set up for *${supplierName}* yet. Send *one line per item* with the Xero item code and unit price (SGD, not quantity):`,
    "",
    ...rows,
    "",
    ...examples,
    "",
    "I will create any new items in Xero, save them here, then create the purchase order.",
  ].join("\n");
}

function supplierLine(name: string, inferred?: boolean): string {
  return inferred
    ? `Supplier: ${name} (usual supplier from your last orders)`
    : `Supplier: ${name}`;
}

function formatItems(items: ParsedOrderItem[]): string {
  return items
    .map((i) => {
      const price =
        i.unitPrice != null ? ` @ S$${Number(i.unitPrice).toFixed(2)}` : " (price unknown)";
      return `- ${i.itemName}: ${i.quantity}${i.unit ? ` ${i.unit}` : ""}${price}`;
    })
    .join("\n");
}

function suggestedOrderNumber(): string {
  return `PO-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
}

export const poIntakeWorkflow = {
  async start(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    const isAuthorized = await authorizationService.isSupervisor(message.from);
    if (!isAuthorized) {
      await whatsappService.sendText(message.from, "Unauthorized. Contact your administrator.");
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    if (!message.text?.trim()) {
      await whatsappService.sendText(message.from, BOT_HELP_GUIDE);
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    const text = message.text.trim();
    if (looksLikeHelpRequest(text)) {
      await whatsappService.sendText(message.from, BOT_HELP_GUIDE);
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { currentStep: "1.1-parse" },
    });

    let parsed;
    try {
      parsed = await llmService.parsePurchaseOrder(text);
    } catch (error) {
      logger.error({ err: error, workflowRunId }, "PO parse failed unexpectedly");
      await whatsappService.sendText(
        message.from,
        "Sorry, I wasn't able to understand or parse that message due to a system error. Please try again with:\n- Item name: 10 kg\n\nOr reply *help* for guidance."
      );
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
      return;
    }

    if (!parsed.isPurchaseOrder || parsed.items.length === 0) {
      await whatsappService.sendText(
        message.from,
        `I couldn't treat that as a purchase order${parsed.reason ? ` (${parsed.reason})` : ""}.\n\n${BOT_HELP_GUIDE}`
      );
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    const draft: PoDraftPayload = {
      items: parsed.items.map((item) => ({
        ...item,
        needsSkuConfirmation: false,
        needsPriceConfirmation: false,
      })),
      messageId: message.messageId,
      from: message.from,
      originalText: text,
    };

    await this.saveDraft(workflowRunId, draft, "1.2-resolve");
    logStep(
      workflowRunId,
      "PO parsed",
      parsed.items.map((i) => `${i.itemName} ${i.quantity}${i.unit ? ` ${i.unit}` : ""}`).join(", ")
    );
    await this.continueResolution(workflowRunId, parsed.supplierName);
  },

  async continueResolution(workflowRunId: string, mentionedName?: string): Promise<void> {
    const organizationId = getOrganizationId();
    const draft = await this.getDraft(workflowRunId);
    if (!draft) return;

    if (!draft.supplierId) {
      const resolved = await poResolutionService.resolveSupplier({
        organizationId,
        mentionedName: mentionedName ?? draft.supplierName,
        items: draft.items,
      });
      if (!resolved.supplier) {
        await this.askSupplierChoice(
          workflowRunId,
          draft,
          mentionedName
            ? `I couldn't match "${mentionedName}". Reply with one of the supplier names below.`
            : resolved.ambiguous
              ? "These items have been ordered from more than one supplier. Reply with one of the names below."
              : undefined
        );
        return;
      }
      draft.supplierConfirmed = true;
      draft.supplierId = resolved.supplier.id;
      draft.supplierName = resolved.supplier.name;
      draft.inferredFromHistory = resolved.inferredFromHistory;
      await this.saveDraft(workflowRunId, draft);
    }

    const resolved = {
      supplier: await prisma.supplier.findFirst({
        where: { id: draft.supplierId, organizationId, isActive: true },
      }),
    };

    if (!resolved.supplier) {
      draft.supplierId = undefined;
      draft.supplierName = undefined;
      draft.supplierConfirmed = false;
      draft.inferredFromHistory = false;
      await this.askSupplierChoice(
        workflowRunId,
        draft,
        "I still need a supplier for this order. Reply with one of the names below."
      );
      return;
    }

    let items: ResolvedPoItem[];
    try {
      items = await poResolutionService.enrichItems(
        organizationId,
        resolved.supplier.id,
        draft.items
      );
    } catch (error) {
      logger.error({ err: error, workflowRunId }, "PO SKU resolution failed");
      if (isXeroError(error)) {
        await notifySupervisorOfXeroError("match items to Xero SKUs", error, draft.from);
      } else {
        await whatsappService.sendText(
          draft.from,
          `⚠️ I couldn't match items to Xero SKUs.\n\nTechnical details: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
      return;
    }
    logStep(
      workflowRunId,
      "PO supplier resolved",
      `${resolved.supplier.name} · ${items
        .map((item) =>
          item.xeroItemCode ? `${item.itemName} → ${item.xeroItemCode}` : item.itemName
        )
        .join(", ")}`
    );
    const nextDraft: PoDraftPayload = {
      ...draft,
      items,
      supplierId: resolved.supplier.id,
      supplierName: resolved.supplier.name,
    };

    const pending = pendingItemDetails(items);
    const inferredNote = nextDraft.inferredFromHistory
      ? `\n${supplierLine(resolved.supplier.name, true)}. Reply *change supplier* if that's wrong.\n`
      : "";
    if (pending.length) {
      await this.awaitApproval(
        workflowRunId,
        { ...nextDraft, pendingGate: "ITEM_DETAILS" },
        ApprovalGateType.NEW_PO_PRICE,
        `${inferredNote}${buildItemDetailsQuestion(resolved.supplier.name, items)}`.trim(),
        ["item code and price", "change supplier"],
        "1.4-item-details"
      );
      return;
    }

    await this.awaitApproval(
      workflowRunId,
      { ...nextDraft, pendingGate: "CONFIRM" },
      ApprovalGateType.SKU_CLARIFICATION,
      [
        "Please confirm this order before I create the PO in the system and Xero:",
        "",
        supplierLine(resolved.supplier.name, nextDraft.inferredFromHistory),
        "Items:",
        formatItems(items),
        "",
        "Reply *yes* to create the PO, *change supplier* to pick another supplier, or *no* to cancel.",
      ].join("\n"),
      ["yes", "change supplier", "no"],
      "1.5-confirm-items"
    );
  },

  async handleModification(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    const organizationId = getOrganizationId();
    const supplier = message.groupId
      ? await authorizationService.getSupplierByGroupId(message.groupId)
      : null;

    if (!supplier) {
      const supervisorPhone =
        (await organizationService.getSupervisorPhone(organizationId)) ?? "+6590000000";
      await whatsappService.sendText(
        supervisorPhone,
        `Group change received but I could not match a supplier for group ${message.groupId ?? "?"}.`
      );
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    const openPo = await prisma.purchaseOrder.findFirst({
      where: { supplierId: supplier.id, status: { in: ["SUBMITTED", "AUTHORISED"] } },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    });

    if (!openPo) {
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    const currentItems: ParsedOrderItem[] = openPo.lines.map((line) => ({
      itemName: line.itemName,
      quantity: Number(line.quantity),
      unit: line.unit ?? undefined,
      xeroItemId: line.xeroItemId ?? undefined,
      unitPrice: line.unitPrice != null ? Number(line.unitPrice) : undefined,
    }));

    const modification = parsePoModification(message.text ?? "", currentItems);
    if (!modification) {
      await approvalService.create({
        workflowRunId,
        gateType: ApprovalGateType.PO_MODIFICATION,
        question: `Supplier group proposed a change I could not parse for ${openPo.xeroPoNumber}: "${message.text}". Approve ignoring it? Reply *no* to ignore.`,
        options: ["no"],
      });
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    const draft: PoDraftPayload = {
      items: modification.items.map((item) => ({
        ...item,
        needsSkuConfirmation: false,
        needsPriceConfirmation: false,
      })),
      supplierId: supplier.id,
      supplierName: supplier.name,
      messageId: message.messageId,
      from: message.from,
      originalText: message.text ?? "",
      pendingGate: "PO_MODIFICATION",
      localPoId: openPo.id,
    };

    await this.awaitApproval(
      workflowRunId,
      draft,
      ApprovalGateType.PO_MODIFICATION,
      [
        `Supplier proposed a change to ${openPo.xeroPoNumber} (${supplier.name}):`,
        modification.summary,
        "",
        "Proposed lines:",
        formatItems(modification.items),
        "",
        "Reply *yes* to apply in Xero, or *no* to keep the original PO.",
      ].join("\n"),
      ["yes", "no"],
      "1.7-modification"
    );
  },

  async onApprovalResolved(
    workflowRunId: string,
    gateType: ApprovalGateType,
    response: string
  ): Promise<void> {
    const answer = response.trim();
    const draft = await this.getDraft(workflowRunId);
    if (!draft) {
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
      return;
    }

    if (isRestartCommand(answer)) {
      const to = draft.from ?? (await organizationService.getSupervisorPhone(getOrganizationId()));
      if (to) {
        await whatsappService.sendText(
          to,
          "Cancelled the previous request. Send a new order when you are ready.\n\n" + BOT_HELP_GUIDE
        );
      }
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    if (gateType === ApprovalGateType.SUPPLIER_CLARIFICATION) {
      if (isAffirmativeReply(answer) && draft.supplierId) {
        draft.supplierConfirmed = true;
        await this.saveDraft(workflowRunId, draft);
        await this.continueResolution(workflowRunId, draft.supplierName);
        return;
      }
      if (looksLikeSupplierChange(answer)) {
        const names = (
          await prisma.supplier.findMany({
            where: { organizationId: getOrganizationId(), isActive: true },
            select: { name: true },
          })
        )
          .map((s) => s.name)
          .join(", ");
        draft.supplierConfirmed = false;
        draft.supplierId = undefined;
        draft.supplierName = undefined;
        draft.inferredFromHistory = false;
        await this.awaitApproval(
          workflowRunId,
          { ...draft, pendingGate: "SUPPLIER_CLARIFICATION" },
          ApprovalGateType.SUPPLIER_CLARIFICATION,
          `Which supplier should this order go to?${names ? ` Known suppliers: ${names}` : ""}`,
          ["supplier name"],
          "1.3-supplier-clarification"
        );
        return;
      }
      draft.supplierConfirmed = true;
      draft.supplierId = undefined;
      draft.supplierName = undefined;
      draft.inferredFromHistory = false;
      await this.saveDraft(workflowRunId, draft);
      await this.continueResolution(workflowRunId, answer);
      return;
    }

    if (gateType === ApprovalGateType.NEW_PO_PRICE) {
      await this.applyPendingItemDetails(workflowRunId, draft, answer);
      return;
    }

    if (gateType === ApprovalGateType.SKU_CLARIFICATION && draft.pendingGate === "SKU_CLARIFICATION") {
      await this.applyPendingItemDetails(workflowRunId, draft, answer);
      return;
    }

    if (gateType === ApprovalGateType.SKU_CLARIFICATION) {
      if (looksLikeSupplierChange(answer)) {
        const names = (
          await prisma.supplier.findMany({
            where: { organizationId: getOrganizationId(), isActive: true },
            select: { name: true },
          })
        )
          .map((s) => s.name)
          .join(", ");
        draft.supplierConfirmed = false;
        draft.supplierId = undefined;
        draft.supplierName = undefined;
        draft.inferredFromHistory = false;
        await this.awaitApproval(
          workflowRunId,
          { ...draft, pendingGate: "SUPPLIER_CLARIFICATION" },
          ApprovalGateType.SUPPLIER_CLARIFICATION,
          `Which supplier should this order go to?${names ? ` Known suppliers: ${names}` : ""}`,
          ["supplier name"],
          "1.3-supplier-clarification"
        );
        return;
      }
      if (isAffirmativeReply(answer)) {
        await this.createConfirmedPurchaseOrder(workflowRunId);
        return;
      }
      const to = draft.from ?? (await organizationService.getSupervisorPhone(getOrganizationId()));
      if (to) {
        await whatsappService.sendText(to, "Order cancelled. No PO was created.\n\n" + BOT_HELP_GUIDE);
      }
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    if (gateType === ApprovalGateType.PO_MODIFICATION) {
      if (isAffirmativeReply(answer)) {
        await this.applyModification(workflowRunId);
        return;
      }
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
    }
  },

  async createConfirmedPurchaseOrder(workflowRunId: string): Promise<void> {
    const organizationId = getOrganizationId();
    const draft = await this.getDraft(workflowRunId);
    if (!draft?.items?.length || !draft.supplierId) {
      const supervisorPhone =
        (await organizationService.getSupervisorPhone(organizationId)) ?? "+6590000000";
      await whatsappService.sendText(
        supervisorPhone,
        "Could not find the draft order to confirm. Please send the order again."
      );
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
      return;
    }

    const supplier = await prisma.supplier.findFirst({
      where: { id: draft.supplierId, organizationId, isActive: true },
    });
    if (!supplier) {
      await whatsappService.sendText(draft.from, "Supplier is no longer available. Please send the order again.");
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
      return;
    }

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { currentStep: "1.6-create-po", status: WorkflowStatus.IN_PROGRESS },
    });

    try {
      const lineItems = draft.items.map((item) => ({
        description: item.itemName,
        quantity: item.quantity,
        unitAmount: item.unitPrice ?? 0,
        itemCode: item.xeroItemCode,
      }));
      const totalAmount = lineItems.reduce(
        (sum, line) => sum + line.quantity * line.unitAmount,
        0
      );
      const orderNumber = suggestedOrderNumber();

      if (supplier.whatsappGroupId) {
        await whatsappService.sendGroupText(
          supplier.whatsappGroupId,
          [`PO Ref: ${orderNumber}`, "Order:", formatItems(draft.items), "Please confirm availability."].join(
            "\n"
          )
        );
      }

      const xeroPo = await xeroService.createPurchaseOrder(organizationId, {
        supplierContactId: supplier.xeroContactId ?? supplier.id,
        contactName: supplier.name,
        purchaseOrderNumber: orderNumber,
        lineItems,
      });
      const confirmedNumber = xeroPo.xeroPoNumber;

      const po = await prisma.purchaseOrder.create({
        data: {
          supplierId: supplier.id,
          xeroPoId: xeroPo.xeroPoId,
          xeroPoNumber: confirmedNumber,
          waThreadId: draft.messageId,
          status: "SUBMITTED",
          totalAmount,
          lines: {
            create: draft.items.map((item) => ({
              itemName: item.itemName,
              quantity: item.quantity,
              unit: item.unit,
              xeroItemId: item.xeroItemId ?? item.xeroItemCode,
              unitPrice: item.unitPrice,
              lineAmount:
                item.unitPrice != null ? item.quantity * item.unitPrice : undefined,
            })),
          },
        },
      });

      await whatsappService.sendText(
        draft.from,
        `✅ PO created: ${confirmedNumber}\nSupplier: ${supplier.name}\nItems:\n${formatItems(draft.items)}`
      );
      logDone(workflowRunId, "PO created", `${confirmedNumber} · ${supplier.name}`);

      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: {
          status: WorkflowStatus.COMPLETED,
          completedAt: new Date(),
          result: { poId: po.id, xeroPoId: xeroPo.xeroPoId },
        },
      });

      await auditService.log({
        workflowRunId,
        triggerEvent: draft.messageId,
        actor: "po-intake",
        sourceChannel: "whatsapp-dm",
        inputs: { message: draft.originalText, items: draft.items },
        outputs: { poId: po.id, xeroPoId: xeroPo.xeroPoId },
        outcome: "success",
      });
    } catch (error) {
      logger.error({ err: error, workflowRunId }, "PO creation failed after confirmation");
      if (isXeroError(error) || /xero/i.test(error instanceof Error ? error.message : "")) {
        await notifySupervisorOfXeroError("create the purchase order", error, draft.from);
      } else {
        await whatsappService.sendText(
          draft.from,
          `⚠️ I couldn't create the purchase order.\nSomething went wrong after you confirmed the order. Please try sending it again, or reply *help*.\n\nTechnical details: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
    }
  },

  async applyModification(workflowRunId: string): Promise<void> {
    const organizationId = getOrganizationId();
    const draft = await this.getDraft(workflowRunId);
    if (!draft?.localPoId || !draft.supplierId) {
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
      return;
    }

    const po = await prisma.purchaseOrder.findUnique({ where: { id: draft.localPoId } });
    const supplier = await prisma.supplier.findUnique({ where: { id: draft.supplierId } });
    if (!po || !supplier) {
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
      return;
    }

    const lineItems = draft.items.map((item) => ({
      description: item.itemName,
      quantity: item.quantity,
      unitAmount: item.unitPrice ?? 0,
      itemCode: item.xeroItemCode,
    }));

    try {
      const updated = await xeroService.updatePurchaseOrder(organizationId, po.xeroPoId ?? po.id, {
        supplierContactId: supplier.xeroContactId ?? supplier.id,
        contactName: supplier.name,
        purchaseOrderNumber: po.xeroPoNumber ?? undefined,
        lineItems,
      });

      await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: po.id } });
      await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: {
          xeroPoId: updated.xeroPoId,
          xeroPoNumber: updated.xeroPoNumber,
          status: "SUBMITTED",
          totalAmount: lineItems.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0),
          lines: {
            create: draft.items.map((item) => ({
              itemName: item.itemName,
              quantity: item.quantity,
              unit: item.unit,
              xeroItemId: item.xeroItemId ?? item.xeroItemCode,
              unitPrice: item.unitPrice,
            })),
          },
        },
      });

      const supervisorPhone =
        (await organizationService.getSupervisorPhone(organizationId)) ?? draft.from;
      await whatsappService.sendText(
        supervisorPhone,
        `✅ PO ${updated.xeroPoNumber} ${updated.voidedAndRecreated ? "voided and recreated" : "updated"}.\n${formatItems(draft.items)}`
      );
      await this.finish(workflowRunId, WorkflowStatus.COMPLETED, {
        poId: po.id,
        voidedAndRecreated: Boolean(updated.voidedAndRecreated),
      });
    } catch (error) {
      logger.error({ err: error, workflowRunId }, "PO modification failed in Xero");
      const supervisorPhone =
        (await organizationService.getSupervisorPhone(organizationId)) ?? draft.from;
      await notifySupervisorOfXeroError("update the purchase order", error, supervisorPhone);
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
    }
  },

  async applyPendingItemDetails(
    workflowRunId: string,
    draft: PoDraftPayload,
    answer: string
  ): Promise<void> {
    if (looksLikeSupplierChange(answer)) {
      const names = (
        await prisma.supplier.findMany({
          where: { organizationId: getOrganizationId(), isActive: true },
          select: { name: true },
        })
      )
        .map((s) => s.name)
        .join(", ");
      draft.supplierConfirmed = false;
      draft.supplierId = undefined;
      draft.supplierName = undefined;
      draft.inferredFromHistory = false;
      await this.awaitApproval(
        workflowRunId,
        { ...draft, pendingGate: "SUPPLIER_CLARIFICATION" },
        ApprovalGateType.SUPPLIER_CLARIFICATION,
        `Which supplier should this order go to?${names ? ` Known suppliers: ${names}` : ""}`,
        ["supplier name"],
        "1.3-supplier-clarification"
      );
      return;
    }

    const pending = pendingItemDetails(draft.items);
    if (!draft.supplierId || pending.length === 0) {
      await this.continueResolution(workflowRunId);
      return;
    }

    const parsed = parsePoItemDetailsReply(
      answer,
      pending.map((item) => item.itemName)
    );
    const acceptNames = isAffirmativeReply(answer);
    if (!parsed.length && !acceptNames) {
      await this.awaitApproval(
        workflowRunId,
        { ...draft, pendingGate: "ITEM_DETAILS" },
        ApprovalGateType.NEW_PO_PRICE,
        `I couldn't read that. ${buildItemDetailsQuestion(draft.supplierName ?? "this supplier", draft.items)}`,
        ["item code and price"],
        "1.4-item-details"
      );
      return;
    }

    try {
      for (let index = 0; index < draft.items.length; index += 1) {
        const item = draft.items[index]!;
        if (!item.needsSkuConfirmation && !item.needsPriceConfirmation) continue;
        const row = parsed.find((entry) => namesMatch(entry.itemName, item.itemName));
        const unitPrice = row?.unitPrice ?? item.unitPrice;
        if (item.needsPriceConfirmation && !(unitPrice != null && unitPrice > 0)) {
          continue;
        }

        let next = { ...item };
        if (unitPrice != null && unitPrice > 0) {
          next = {
            ...next,
            unitPrice,
            priceSource: "confirmed",
            needsPriceConfirmation: false,
          };
        }

        if (next.needsSkuConfirmation && !next.needsPriceConfirmation) {
          const mapped = await skuMappingService.ensureMappedItem(
            getOrganizationId(),
            draft.supplierId,
            next.itemName,
            {
              code: row?.code,
              unitPrice: next.unitPrice,
              confirmedBy: draft.from,
            }
          );
          next = {
            ...next,
            xeroItemId: mapped.itemId,
            xeroItemCode: mapped.code,
            needsSkuConfirmation: false,
          };
          logStep(
            workflowRunId,
            "Xero item ready",
            `${next.itemName} → ${mapped.code}`
          );
        }
        draft.items[index] = next;
      }
    } catch (error) {
      logger.error({ err: error, workflowRunId }, "Creating Xero items for PO failed");
      await notifySupervisorOfXeroError("create new Xero items for this order", error, draft.from);
      return;
    }

    await this.saveDraft(workflowRunId, draft);
    const stillPending = pendingItemDetails(draft.items);
    if (stillPending.length) {
      await this.awaitApproval(
        workflowRunId,
        { ...draft, pendingGate: "ITEM_DETAILS" },
        ApprovalGateType.NEW_PO_PRICE,
        buildItemDetailsQuestion(draft.supplierName ?? "this supplier", draft.items),
        ["item code and price"],
        "1.4-item-details"
      );
      return;
    }
    await this.createConfirmedPurchaseOrder(workflowRunId);
  },

  async askSupplierChoice(
    workflowRunId: string,
    draft: PoDraftPayload,
    intro?: string
  ): Promise<void> {
    const suppliers = await prisma.supplier.findMany({
      where: { organizationId: getOrganizationId(), isActive: true },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    const names = suppliers.map((supplier) => `• ${supplier.name}`).join("\n") || "• (no suppliers yet — add one in Admin)";
    await this.awaitApproval(
      workflowRunId,
      { ...draft, pendingGate: "SUPPLIER_CLARIFICATION", supplierConfirmed: false },
      ApprovalGateType.SUPPLIER_CLARIFICATION,
      [intro, "Which supplier should this order go to?", names, "", "Reply with the supplier name."]
        .filter(Boolean)
        .join("\n"),
      ["supplier name"],
      "1.3-supplier-clarification"
    );
  },

  async awaitApproval(
    workflowRunId: string,
    draft: PoDraftPayload,
    gateType: ApprovalGateType,
    question: string,
    options: string[],
    currentStep: string
  ): Promise<void> {
    await this.saveDraft(workflowRunId, draft, currentStep, WorkflowStatus.AWAITING_APPROVAL);
    await approvalService.create({ workflowRunId, gateType, question, options });
  },

  async saveDraft(
    workflowRunId: string,
    draft: PoDraftPayload,
    currentStep?: string,
    status?: WorkflowStatus
  ): Promise<void> {
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        payload: draft as object,
        ...(currentStep ? { currentStep } : {}),
        ...(status ? { status } : {}),
      },
    });
  },

  async getDraft(workflowRunId: string): Promise<PoDraftPayload | null> {
    const run = await prisma.workflowRun.findUnique({ where: { id: workflowRunId } });
    return (run?.payload as PoDraftPayload | null) ?? null;
  },

  async finish(
    workflowRunId: string,
    status: WorkflowStatus,
    result?: object
  ): Promise<void> {
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        status,
        completedAt: new Date(),
        ...(result ? { result } : {}),
      },
    });
  },
};
