import { WorkflowStatus } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getOrganizationId } from "../../context/tenant.js";
import { llmService } from "../../services/llm.service.js";
import { xeroService } from "../../services/xero.service.js";
import { whatsappService } from "../../services/whatsapp.service.js";
import { approvalService } from "../../services/approval.service.js";
import { authorizationService } from "../../services/authorization.service.js";
import { organizationService } from "../../services/organization.service.js";
import { auditService } from "../../services/audit.service.js";
import type { WhatsAppInboundMessage } from "../../types/index.js";
import { ApprovalGateType } from "@prisma/client";

export const poIntakeWorkflow = {
  async start(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    const organizationId = getOrganizationId();
    const isAuthorized = await authorizationService.isSupervisor(message.from);
    if (!isAuthorized) {
      await whatsappService.sendText(message.from, "Unauthorized. Contact your administrator.");
      return;
    }

    if (!message.text) {
      await whatsappService.sendText(
        message.from,
        "Please send items in this format:\n- Bok choy: 10 kg\n- Zucchini: 40 kg"
      );
      return;
    }

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { currentStep: "1.1-parse" },
    });

    const items = await llmService.parsePurchaseOrder(message.text);

    if (items.length === 0) {
      await whatsappService.sendText(message.from, "Could not parse your order. Please check the format.");
      return;
    }

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { currentStep: "1.2-sku-resolution", payload: { items } as object },
    });

    const supplier = await prisma.supplier.findFirst({
      where: { organizationId, isActive: true },
    });
    if (!supplier) {
      await approvalService.create({
        workflowRunId,
        gateType: ApprovalGateType.SUPPLIER_CLARIFICATION,
        question: "No supplier found. Which supplier should this order go to?",
      });
      return;
    }

    const poNumber = `PO-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
    const lineItems = items.map((item) => ({
      description: item.itemName,
      quantity: item.quantity,
      unitAmount: 0,
    }));

    const xeroPo = await xeroService.createPurchaseOrder(organizationId, {
      supplierContactId: supplier.xeroContactId ?? supplier.id,
      contactName: supplier.name,
      lineItems,
    });

    const po = await prisma.purchaseOrder.create({
      data: {
        supplierId: supplier.id,
        xeroPoId: xeroPo.xeroPoId,
        xeroPoNumber: xeroPo.xeroPoNumber,
        waThreadId: message.messageId,
        status: "SUBMITTED",
        lines: {
          create: items.map((item) => ({
            itemName: item.itemName,
            quantity: item.quantity,
            unit: item.unit,
          })),
        },
      },
    });

    if (supplier.whatsappGroupId) {
      const orderText = [
        `PO Ref: ${poNumber}`,
        "Order:",
        ...items.map((i) => `- ${i.itemName}: ${i.quantity}${i.unit ? ` ${i.unit}` : ""}`),
        "Please confirm availability.",
      ].join("\n");
      await whatsappService.sendGroupText(supplier.whatsappGroupId, orderText);
    }

    await whatsappService.sendText(
      message.from,
      `✅ PO created: ${poNumber}\nSupplier: ${supplier.name}\nItems: ${items.length}`
    );

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: WorkflowStatus.COMPLETED, completedAt: new Date(), result: { poId: po.id } },
    });

    await auditService.log({
      workflowRunId,
      triggerEvent: message.messageId,
      actor: "po-intake",
      sourceChannel: "whatsapp-dm",
      inputs: { message: message.text, items },
      outputs: { poId: po.id, xeroPoId: xeroPo.xeroPoId },
      outcome: "success",
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
    if (gateType === ApprovalGateType.PO_MODIFICATION && response.toLowerCase() === "yes") {
      const supervisorPhone =
        (await organizationService.getSupervisorPhone(getOrganizationId())) ?? "+6590000000";
      await whatsappService.sendText(supervisorPhone, "PO modification approved and applied (scaffold).");
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: WorkflowStatus.COMPLETED, completedAt: new Date() },
      });
    }
  },
};
