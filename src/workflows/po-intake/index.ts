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
import { BOT_HELP_GUIDE } from "../../prompts/system.js";
import { logger } from "../../utils/logger.js";
import type { ParsedOrderItem, WhatsAppInboundMessage } from "../../types/index.js";

interface PoDraftPayload {
  items: ParsedOrderItem[];
  supplierId: string;
  supplierName: string;
  messageId: string;
  from: string;
  originalText: string;
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

function formatItems(items: ParsedOrderItem[]): string {
  return items
    .map((i) => `- ${i.itemName}: ${i.quantity}${i.unit ? ` ${i.unit}` : ""}`)
    .join("\n");
}

export const poIntakeWorkflow = {
  async start(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    const organizationId = getOrganizationId();
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

    const supplier = await prisma.supplier.findFirst({
      where: { organizationId, isActive: true },
      orderBy: { createdAt: "asc" },
    });

    if (!supplier) {
      await approvalService.create({
        workflowRunId,
        gateType: ApprovalGateType.SUPPLIER_CLARIFICATION,
        question: "No supplier found. Which supplier should this order go to?",
        options: ["Reply with the supplier name"],
      });
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: {
          status: WorkflowStatus.AWAITING_APPROVAL,
          currentStep: "1.3-supplier-clarification",
          payload: {
            items: parsed.items,
            messageId: message.messageId,
            from: message.from,
            originalText: text,
          } as object,
        },
      });
      return;
    }

    const draft: PoDraftPayload = {
      items: parsed.items,
      supplierId: supplier.id,
      supplierName: supplier.name,
      messageId: message.messageId,
      from: message.from,
      originalText: text,
    };

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        status: WorkflowStatus.AWAITING_APPROVAL,
        currentStep: "1.5-confirm-items",
        payload: draft as object,
      },
    });

    await approvalService.create({
      workflowRunId,
      gateType: ApprovalGateType.SKU_CLARIFICATION,
      question: [
        "Please confirm this order before I create the PO in the system and Xero:",
        "",
        `Supplier: ${supplier.name}`,
        "Items:",
        formatItems(parsed.items),
        "",
        "Reply *yes* to create the PO, or *no* to cancel.",
      ].join("\n"),
      options: ["yes", "no"],
    });
  },

  async handleModification(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    await approvalService.create({
      workflowRunId,
      gateType: ApprovalGateType.PO_MODIFICATION,
      question: `Modify PO based on: "${message.text ?? ""}"?`,
    });
  },

  async onApprovalResolved(
    workflowRunId: string,
    gateType: ApprovalGateType,
    response: string
  ): Promise<void> {
    const answer = response.trim().toLowerCase();

    if (gateType === ApprovalGateType.SKU_CLARIFICATION) {
      if (answer === "yes" || answer === "approve") {
        await this.createConfirmedPurchaseOrder(workflowRunId);
        return;
      }

      const run = await prisma.workflowRun.findUnique({ where: { id: workflowRunId } });
      const draft = run?.payload as Partial<PoDraftPayload> | null;
      const to = draft?.from ?? (await organizationService.getSupervisorPhone(getOrganizationId()));
      if (to) {
        await whatsappService.sendText(to, "Order cancelled. No PO was created.\n\n" + BOT_HELP_GUIDE);
      }
      await this.finish(workflowRunId, WorkflowStatus.CANCELLED);
      return;
    }

    if (gateType === ApprovalGateType.PO_MODIFICATION && answer === "yes") {
      const supervisorPhone =
        (await organizationService.getSupervisorPhone(getOrganizationId())) ?? "+6590000000";
      await whatsappService.sendText(
        supervisorPhone,
        "PO modification approved and applied (scaffold)."
      );
      await this.finish(workflowRunId, WorkflowStatus.COMPLETED);
    }
  },

  async createConfirmedPurchaseOrder(workflowRunId: string): Promise<void> {
    const organizationId = getOrganizationId();
    const run = await prisma.workflowRun.findUnique({ where: { id: workflowRunId } });
    const draft = run?.payload as PoDraftPayload | null;

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
      await whatsappService.sendText(
        draft.from,
        "Supplier is no longer available. Please send the order again."
      );
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
      return;
    }

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { currentStep: "1.6-create-po", status: WorkflowStatus.IN_PROGRESS },
    });

    try {
      // Same ref for WhatsApp/system messages and Xero PurchaseOrderNumber
      const poNumber = `PO-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
      const lineItems = draft.items.map((item) => ({
        description: item.itemName,
        quantity: item.quantity,
        unitAmount: 0,
      }));

      const xeroPo = await xeroService.createPurchaseOrder(organizationId, {
        supplierContactId: supplier.xeroContactId ?? supplier.id,
        contactName: supplier.name,
        purchaseOrderNumber: poNumber,
        lineItems,
      });

      // Prefer Xero's returned number so messages always match what is in Xero
      const displayPoNumber = xeroPo.xeroPoNumber || poNumber;

      const po = await prisma.purchaseOrder.create({
        data: {
          supplierId: supplier.id,
          xeroPoId: xeroPo.xeroPoId,
          xeroPoNumber: displayPoNumber,
          waThreadId: draft.messageId,
          status: "SUBMITTED",
          lines: {
            create: draft.items.map((item) => ({
              itemName: item.itemName,
              quantity: item.quantity,
              unit: item.unit,
            })),
          },
        },
      });

      if (supplier.whatsappGroupId) {
        const orderText = [
          `PO Ref: ${displayPoNumber}`,
          "Order:",
          formatItems(draft.items),
          "Please confirm availability.",
        ].join("\n");
        await whatsappService.sendGroupText(supplier.whatsappGroupId, orderText);
      }

      await whatsappService.sendText(
        draft.from,
        `✅ PO created: ${displayPoNumber}\nSupplier: ${supplier.name}\nItems:\n${formatItems(draft.items)}`
      );

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
      await whatsappService.sendText(
        draft.from,
        "Sorry, I failed to create the purchase order due to a system error. Please try sending the order again, or reply *help* for guidance."
      );
      await this.finish(workflowRunId, WorkflowStatus.FAILED);
    }
  },

  async finish(workflowRunId: string, status: WorkflowStatus): Promise<void> {
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        status,
        completedAt: new Date(),
      },
    });
  },
};
