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
import { logger } from "../../utils/logger.js";
import { logDone, logStep } from "../../utils/workflow-log.js";
import { isXeroError, notifySupervisorOfXeroError } from "../../utils/xero-error.js";
import type { PayableList } from "../../types/index.js";
import { isReadyReply } from "../../utils/matching.js";
import {
  asBillIds,
  billIdsOverlap,
  cancelStandbyBatches,
  IN_FLIGHT_PAYMENT_STATUSES,
} from "../../utils/payment-batch.js";

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
    if (!hasPayee || !(await dbsPlaywrightService.payeeExists(reconciliation.supplier.dbsPayeeName ?? ""))) {
      await whatsappService.sendText(
        await getSupervisorPhone(),
        `There's no saved DBS payee for *${reconciliation.supplier.name}*, so I didn't start payment.\n\nI can't add new payees. Please save this supplier in DBS IDEAL first, then reconcile again.`
      );
      await prisma.workflowRun.update({
        where: { id: workflowRun.id },
        data: { status: WorkflowStatus.FAILED, error: "No saved DBS payee", completedAt: new Date() },
      });
      return;
    }

    const billIds = payableList.items.map((item) => item.xeroBillId);
    const existing = await prisma.paymentBatch.findMany({
      where: {
        supplierId: reconciliation.supplierId,
        status: { in: IN_FLIGHT_PAYMENT_STATUSES },
      },
    });
    const alreadyRaised = existing.find(
      (row) =>
        row.status !== PaymentBatchStatus.STANDBY_REQUESTED && billIdsOverlap(row.xeroBillIds, billIds)
    );
    if (alreadyRaised) {
      await whatsappService.sendText(
        await getSupervisorPhone(),
        [
          `These bills are already in a DBS payment for *${reconciliation.supplier.name}*.`,
          alreadyRaised.dbsTransactionRef ? `Reference: ${alreadyRaised.dbsTransactionRef}` : "Waiting for you to reply *ready*, or for the bank approver.",
          "I won't submit the same payment again.",
        ].join("\n")
      );
      await prisma.workflowRun.update({
        where: { id: workflowRun.id },
        data: { status: WorkflowStatus.CANCELLED, error: "Duplicate payment skipped", completedAt: new Date() },
      });
      return;
    }

    await cancelStandbyBatches(
      existing
        .filter(
          (row) =>
            row.status === PaymentBatchStatus.STANDBY_REQUESTED &&
            billIdsOverlap(row.xeroBillIds, billIds)
        )
        .map((row) => row.id),
      "superseded by a new payable list"
    );

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
      question: [
        `Payable list is ready for *${payableList.supplierName}*.`,
        "",
        `Amount: S$${payableList.totalAmount.toFixed(2)}`,
        `Reference: ${payableList.referenceText}`,
        "",
        "Please keep the DBS mobile app open so you can approve the login, then reply *ready*.",
      ].join("\n"),
      options: ["ready"],
    });

    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: { currentStep: "4.3-standby", result: { paymentBatchId: batch.id } },
    });
    logStep(
      workflowRun.id,
      "DBS standby",
      `${payableList.supplierName} S$${payableList.totalAmount.toFixed(2)} — reply ready`
    );
  },

  async onApprovalResolved(
    workflowRunId: string,
    gateType: ApprovalGateType,
    response: string
  ): Promise<void> {
    if (gateType !== ApprovalGateType.DBS_STANDBY || !isReadyReply(response)) {
      return;
    }

    const organizationId = getOrganizationId();
    const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: workflowRunId } });
    const result = run.result as { paymentBatchId?: string } | null;
    if (!result?.paymentBatchId) return;

    const sessionOk = await dbsPlaywrightService.acquireSession(organizationId);
    if (!sessionOk) {
      await whatsappService.sendText(
        await getSupervisorPhone(),
        "DBS is already in use on the office machine. I'll try again in 30 minutes. Reply *ready* then if I haven't come back."
      );
      return;
    }

    try {
      const thisBatch = await prisma.paymentBatch.findUnique({
        where: { id: result.paymentBatchId },
        include: { supplier: true, reconciliationRun: true },
      });
      if (!thisBatch || thisBatch.status !== PaymentBatchStatus.STANDBY_REQUESTED) {
        await whatsappService.sendText(
          await getSupervisorPhone(),
          "That payment is no longer waiting. If it was already submitted, I won't raise it again."
        );
        return;
      }

      const extras = await prisma.paymentBatch.findMany({
        where: {
          id: { not: thisBatch.id },
          status: PaymentBatchStatus.STANDBY_REQUESTED,
          supplier: { organizationId },
        },
        include: { supplier: true, reconciliationRun: true },
      });
      const duplicates = extras.filter((row) => billIdsOverlap(row.xeroBillIds, thisBatch.xeroBillIds));
      await cancelStandbyBatches(
        duplicates.map((row) => row.id),
        "duplicate of the payment raised from this ready reply"
      );
      const batches = [thisBatch, ...extras.filter((row) => !billIdsOverlap(row.xeroBillIds, thisBatch.xeroBillIds))];

      const raisedBillIds = new Set<string>();
      for (const batch of batches) {
        const payableList = batch.reconciliationRun?.payableList as PayableList | null;
        if (!payableList) continue;
        if (asBillIds(batch.xeroBillIds).some((id) => raisedBillIds.has(id))) {
          await prisma.paymentBatch.update({
            where: { id: batch.id },
            data: {
              status: PaymentBatchStatus.FAILED,
              error: "Duplicate of a payment already raised in this session",
            },
          });
          continue;
        }

        await prisma.paymentBatch.update({
          where: { id: batch.id },
          data: { status: PaymentBatchStatus.LOGGING_IN },
        });

        const paymentResult = await dbsPlaywrightService.raisePayment(payableList);

        await prisma.paymentBatch.update({
          where: { id: batch.id },
          data: {
            status: PaymentBatchStatus.AWAITING_BANK_APPROVAL,
            dbsTransactionRef: paymentResult.transactionRef,
            raisedAt: new Date(),
          },
        });
        for (const id of asBillIds(batch.xeroBillIds)) raisedBillIds.add(id);

        for (const item of payableList.items) {
          try {
            await xeroService.updateBillStatus(
              organizationId,
              item.xeroBillId,
              "AWAITING_PAYMENT",
              `DBS ref: ${paymentResult.transactionRef}`
            );
          } catch (error) {
            await notifySupervisorOfXeroError(
              `mark bill ${item.invoiceNumber} as awaiting payment`,
              error
            );
            throw error;
          }
          await prisma.xeroBill.updateMany({
            where: { xeroBillId: item.xeroBillId },
            data: { status: "AWAITING_PAYMENT", dbsReference: paymentResult.transactionRef },
          });
        }

        await whatsappService.sendText(
          await getSupervisorPhone(),
          [
            `Payment submitted in DBS for *${batch.supplier.name}*.`,
            "",
            `Amount: S$${Number(batch.totalAmount).toFixed(2)}`,
            `Reference: ${paymentResult.transactionRef}`,
            "",
            "Xero bills are *Awaiting Payment* (not Paid yet). I'll mark them Paid only after the independent DBS approver confirms.",
          ].join("\n")
        );
        logDone(
          workflowRunId,
          "DBS payment raised",
          `${batch.supplier.name} · ${paymentResult.transactionRef} · Awaiting Payment`
        );

        await auditService.log({
          workflowRunId,
          triggerEvent: "payment.raised",
          actor: "payment-execution",
          sourceChannel: "dbs",
          outputs: { transactionRef: paymentResult.transactionRef, batchId: batch.id },
          outcome: "success",
        });
      }

      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: WorkflowStatus.COMPLETED, completedAt: new Date() },
      });
    } catch (error) {
      logger.error({ err: error, workflowRunId }, "Payment execution failed after DBS raise");
      if (isXeroError(error)) {
        await notifySupervisorOfXeroError("update Xero bills after raising the DBS payment", error);
      } else {
        await whatsappService.sendText(
          await getSupervisorPhone(),
          `I couldn't submit the DBS payment, so Xero was not updated.\n\n${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: {
          status: WorkflowStatus.FAILED,
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      });
    } finally {
      await dbsPlaywrightService.releaseSession(organizationId);
    }
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
      try {
        for (const billId of billIds) {
          await xeroService.updateBillStatus(organizationId, billId, "PAID");
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
          [
            `DBS approved the payment to *${batch.supplier.name}*.`,
            "",
            `Amount: S$${Number(batch.totalAmount).toFixed(2)}`,
            `Reference: ${batch.dbsTransactionRef}`,
            "",
            "Related bills are now marked *Paid* in Xero.",
          ].join("\n")
        );
        logDone(undefined, "DBS approved · Xero Paid", batch.dbsTransactionRef);
      } catch (error) {
        logger.error({ err: error, batchId: batch.id }, "Failed to mark Xero bills Paid");
        await notifySupervisorOfXeroError(
          `mark bills as Paid after DBS approval (ref ${batch.dbsTransactionRef})`,
          error
        );
      }
    }
  },
};
