import { PaymentBatchStatus } from "@prisma/client";
import { prisma } from "../db/client.js";

export const IN_FLIGHT_PAYMENT_STATUSES: PaymentBatchStatus[] = [
  PaymentBatchStatus.STANDBY_REQUESTED,
  PaymentBatchStatus.LOGGING_IN,
  PaymentBatchStatus.RAISED,
  PaymentBatchStatus.AWAITING_BANK_APPROVAL,
];

export function asBillIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function billIdsOverlap(left: unknown, right: unknown): boolean {
  const other = new Set(asBillIds(right));
  return asBillIds(left).some((id) => other.has(id));
}

export async function listInFlightBillIds(supplierId: string): Promise<Set<string>> {
  const batches = await prisma.paymentBatch.findMany({
    where: { supplierId, status: { in: IN_FLIGHT_PAYMENT_STATUSES } },
    select: { xeroBillIds: true },
  });
  return new Set(batches.flatMap((row) => asBillIds(row.xeroBillIds)));
}

export async function cancelStandbyBatches(ids: string[], reason: string): Promise<void> {
  if (!ids.length) return;
  await prisma.paymentBatch.updateMany({
    where: { id: { in: ids }, status: PaymentBatchStatus.STANDBY_REQUESTED },
    data: { status: PaymentBatchStatus.FAILED, error: reason },
  });
}
