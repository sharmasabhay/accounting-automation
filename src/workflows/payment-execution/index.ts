import { WorkflowStatus, ApprovalGateType, PaymentBatchStatus } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getOrganizationId } from "../../context/tenant.js";
import { authorizationService } from "../../services/authorization.service.js";
import { organizationService } from "../../services/organization.service.js";
import { dbsPlaywrightService } from "../../services/dbs-playwright.service.js";
import { xeroService } from "../../services/xero.service.js";
import { whatsappService } from "../../services/whatsapp.service.js";
import { approvalService } from "../../services/approval.service.js";
import { auditService } from "../../services/audit.service.js";
import type { PayableList } from "../../types/index.js";

async function getSupervisorPhone(): Promise<string> {
  return (await organizationService.getSupervisorPhone(getOrganizationId())) ?? "+6590000000";
}

export const paymentExecutionWorkflow = {
  async start(reconciliationRunId: string): Promise<void> {
    const organizationId = getOrganizationId();
    const reconciliation = await prisma.reconciliationRun.findUniqueOrThrow({
      where: { id: reconciliationRunId },
      include: { supplier: true },
    });

    if (reconciliation.supplier.organizationId !== organizationId) {
      throw new Error("Reconciliation does not belong to current organization");
    }

    const payableList = reconciliation.payableList as PayableList | null;
    if (!payableList || payableList.items.length === 0) {
      return;
    }

    const workflowRun = await prisma.workflowRun.create({
      data: {
        organizationId,
        type: "PAYMENT_EXECUTION",
        status: WorkflowStatus.IN_PROGRESS,
        triggerRef: reconciliationRunId,
        payload: payableList as object,
      },
    });

    const hasPayee = await authorizationService.hasSavedPayee(reconciliation.supplierId);
    if (!hasPayee) {
      await whatsappService.sendText(
        await getSupervisorPhone(),
        `❌ No saved DBS payee for ${reconciliation.supplier.name}. Payment stopped.`
      );
      return;
    }

    const batch = await prisma.paymentBatch.create({
      data: {
        supplierId: reconciliation.supplierId,
        reconciliationRunId,
        totalAmount: payableList.totalAmount,
        referenceText: payableList.referenceText,
        xeroBillIds: payableList.items.map((i) => i.xeroBillId),
        status: PaymentBatchStatus.STANDBY_REQUESTED,
      },
    });

    await approvalService.create({
      workflowRunId: workflowRun.id,
      gateType: ApprovalGateType.DBS_STANDBY,
      question: `Ready to log in to DBS for payment to ${payableList.supplierName}: S$${payableList.totalAmount.toFixed(2)}, ref: ${payableList.referenceText}. Reply 'ready' when standing by with DBS app.`,
      options: ["ready"],
    });

    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: { currentStep: "4.3-standby", result: { paymentBatchId: batch.id } },
    });
  },

  async onApprovalResolved(
    workflowRunId: string,
    gateType: ApprovalGateType,
    response: string
  ): Promise<void> {
    if (gateType !== ApprovalGateType.DBS_STANDBY || response.toLowerCase() !== "ready") {
      return;
    }

    const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: workflowRunId } });
    const result = run.result as { paymentBatchId?: string } | null;
    if (!result?.paymentBatchId) return;

    const batch = await prisma.paymentBatch.findUniqueOrThrow({
      where: { id: result.paymentBatchId },
      include: { supplier: true, reconciliationRun: true },
    });

    const payableList = batch.reconciliationRun?.payableList as PayableList | null;
    if (!payableList) return;

    await prisma.paymentBatch.update({
      where: { id: batch.id },
      data: { status: PaymentBatchStatus.LOGGING_IN },
    });

    const sessionOk = await dbsPlaywrightService.isSessionAvailable();
    if (!sessionOk) {
      await whatsappService.sendText(
        await getSupervisorPhone(),
        "DBS session occupied. Will retry in 30 minutes."
      );
      return;
    }

    const paymentResult = await dbsPlaywrightService.raisePayment(payableList);

    await prisma.paymentBatch.update({
      where: { id: batch.id },
      data: {
        status: PaymentBatchStatus.AWAITING_BANK_APPROVAL,
        dbsTransactionRef: paymentResult.transactionRef,
        raisedAt: new Date(),
      },
    });

    for (const item of payableList.items) {
      await xeroService.updateBillStatus(
        getOrganizationId(),
        item.xeroBillId,
        "AWAITING_PAYMENT",
        `DBS ref: ${paymentResult.transactionRef}`
      );
      await prisma.xeroBill.updateMany({
        where: { xeroBillId: item.xeroBillId },
        data: { status: "AWAITING_PAYMENT", dbsReference: paymentResult.transactionRef },
      });
    }

    await whatsappService.sendText(
      await getSupervisorPhone(),
      `✅ Payment raised in DBS: ${batch.supplier.name} S$${Number(batch.totalAmount).toFixed(2)} — ref ${paymentResult.transactionRef}`
    );

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: WorkflowStatus.COMPLETED, completedAt: new Date() },
    });

    await auditService.log({
      workflowRunId,
      triggerEvent: "payment.raised",
      actor: "payment-execution",
      sourceChannel: "dbs",
      outputs: { transactionRef: paymentResult.transactionRef, batchId: batch.id },
      outcome: "success",
    });
  },

  async monitorApprovals(): Promise<void> {
    const organizationId = getOrganizationId();

    const pending = await prisma.paymentBatch.findMany({
      where: {
        status: PaymentBatchStatus.AWAITING_BANK_APPROVAL,
        supplier: { organizationId },
      },
      include: { supplier: true },
    });

    for (const batch of pending) {
      if (!batch.dbsTransactionRef) continue;

      const approved = await dbsPlaywrightService.checkPaymentApproval(batch.dbsTransactionRef);
      if (!approved) continue;

      const billIds = batch.xeroBillIds as string[];
      for (const billId of billIds) {
        await xeroService.updateBillStatus(getOrganizationId(), billId, "PAID");
        await prisma.xeroBill.updateMany({
          where: { xeroBillId: billId },
          data: { status: "PAID", paidAt: new Date() },
        });
      }

      await prisma.paymentBatch.update({
        where: { id: batch.id },
        data: { status: PaymentBatchStatus.APPROVED, approvedAt: new Date() },
      });

      await whatsappService.sendText(
        await getSupervisorPhone(),
        `Payment to supplier approved and marked Paid in Xero. Ref: ${batch.dbsTransactionRef}`
      );
    }
  },
};
