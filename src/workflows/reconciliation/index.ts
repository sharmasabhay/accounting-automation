import { WorkflowStatus, ApprovalGateType } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getOrganizationId } from "../../context/tenant.js";
import { authorizationService } from "../../services/authorization.service.js";
import { organizationService } from "../../services/organization.service.js";
import { whatsappService } from "../../services/whatsapp.service.js";
import { auditService } from "../../services/audit.service.js";
import type { WhatsAppInboundMessage, PayableList } from "../../types/index.js";
import { enqueueJob } from "../../jobs/queue.js";

function getPreviousMonth(): { start: Date; end: Date; label: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const label = start.toLocaleString("en-SG", { month: "long", year: "numeric" });
  return { start, end, label };
}

export const reconciliationWorkflow = {
  async startFromDm(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    const isAuthorized = await authorizationService.isSupervisor(message.from);
    if (!isAuthorized) return;

    const organizationId = getOrganizationId();
    const text = message.text ?? "";
    const supplier = await prisma.supplier.findFirst({
      where: {
        organizationId,
        name: { contains: text.replace(/reconcile|payment|statement|for|please|check/gi, "").trim(), mode: "insensitive" },
      },
    });

    if (!supplier) {
      await whatsappService.sendText(message.from, "Which supplier should I reconcile? Please include the supplier name.");
      return;
    }

    await this.runReconciliation(workflowRunId, supplier.id, message.from);
  },

  async startFromGroup(workflowRunId: string, message: WhatsAppInboundMessage): Promise<void> {
    const supplier = message.groupId
      ? await authorizationService.getSupplierByGroupId(message.groupId)
      : null;

    if (!supplier) {
      const supervisorPhone =
        (await organizationService.getSupervisorPhone(getOrganizationId())) ?? "+6590000000";
      await whatsappService.sendText(
        supervisorPhone,
        "Could not infer supplier from group. Please reconcile via DM with supplier name."
      );
      return;
    }

    const supervisorPhone =
      (await organizationService.getSupervisorPhone(getOrganizationId())) ?? "+6590000000";
    await this.runReconciliation(workflowRunId, supplier.id, supervisorPhone);
  },

  async runReconciliation(
    workflowRunId: string,
    supplierId: string,
    notifyPhone: string
  ): Promise<void> {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } });
    const period = getPreviousMonth();

    const bills = await prisma.xeroBill.findMany({
      where: {
        supplierId,
        status: { in: ["SUBMITTED", "AWAITING_PAYMENT"] },
        invoiceDate: { gte: period.start, lte: period.end },
      },
    });

    const payableList: PayableList = {
      supplierId,
      supplierName: supplier.name,
      period: period.label,
      items: bills.map((b) => ({
        invoiceNumber: b.invoiceNumber ?? "UNKNOWN",
        amount: Number(b.totalAmount ?? 0),
        xeroBillId: b.xeroBillId ?? b.id,
      })),
      totalAmount: bills.reduce((sum, b) => sum + Number(b.totalAmount ?? 0), 0),
      referenceText: period.label,
    };

    const reconciliation = await prisma.reconciliationRun.create({
      data: {
        supplierId,
        periodStart: period.start,
        periodEnd: period.end,
        payableList: payableList as object,
        summary: {
          matched: payableList.items.length,
          total: payableList.totalAmount,
        } as object,
        status: "COMPLETED",
      },
    });

    const summary = [
      `Reconciliation: ${supplier.name} — ${period.label}`,
      "",
      `Xero bills: ${bills.length} (total S$${payableList.totalAmount.toFixed(2)})`,
      "",
      "Payable list (proceeding to payment):",
      ...payableList.items.map((i) => `- ${i.invoiceNumber} S$${i.amount.toFixed(2)}`),
      `Total: S$${payableList.totalAmount.toFixed(2)}`,
    ].join("\n");

    await whatsappService.sendText(notifyPhone, summary);

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: WorkflowStatus.COMPLETED, completedAt: new Date(), result: { reconciliationId: reconciliation.id } },
    });

    await auditService.log({
      workflowRunId,
      triggerEvent: "reconciliation.completed",
      actor: "reconciliation",
      sourceChannel: "whatsapp",
      outputs: { reconciliationId: reconciliation.id, payableList },
      outcome: "success",
    });

    await enqueueJob("reconciliation.payable.ready", {
      reconciliationRunId: reconciliation.id,
      organizationId: getOrganizationId(),
    });
  },

  async onApprovalResolved(
    workflowRunId: string,
    _gateType: ApprovalGateType,
    _response: string
  ): Promise<void> {
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: WorkflowStatus.COMPLETED, completedAt: new Date() },
    });
  },
};
