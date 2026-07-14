import type { Prisma } from "@prisma/client";
import { NotFoundError, ValidationError } from "../lib/errors.js";

// ─── Vendor / purchase-bill payment recording ────────────────────────
//
// Single consolidated implementation of "record a payment against a purchase bill" — previously
// duplicated between routes/purchaseBills.ts's dedicated POST /:id/payment and routes/payments.ts's
// generic POST / (relatedType=PURCHASE_BILL branch), each independently summing prior payments and
// flipping bill status. Both routes now call this instead, so there's exactly one place that can
// get the math wrong, and exactly one place that keeps Vendor.outstandingBalance in sync.

export interface RecordVendorPaymentInput {
  amount: number;
  paymentMode: string;
  paymentDate?: Date;
  referenceNumber?: string;
  bankAccount?: string;
  narration?: string;
}

/**
 * Records a PAYMENT (never a RECEIPT — a purchase-bill payment is definitionally money going out to
 * the vendor) against a purchase bill: validates the amount against what's actually still owed,
 * creates the Payment row, flips PurchaseBill.status to PAID/PARTIALLY_PAID, and decrements
 * Vendor.outstandingBalance by the same amount — the one write path that keeps that rollup correct
 * (mirrors the denormalized-rollup convention services/stockBatches.ts already established for
 * ProductVariant.stock/costPrice).
 */
export async function recordVendorPayment(
  tx: Prisma.TransactionClient,
  billId: string,
  input: RecordVendorPaymentInput,
) {
  const bill = await tx.purchaseBill.findUnique({ where: { id: billId } });
  if (!bill) throw new NotFoundError("PurchaseBill", billId);

  const existingPayments = await tx.payment.aggregate({
    where: { relatedType: "PURCHASE_BILL", relatedId: billId, status: "COMPLETED" },
    _sum: { amount: true },
  });
  const alreadyPaid = Number(existingPayments._sum.amount ?? 0);
  const remaining = Math.round((Number(bill.netPayable) - alreadyPaid) * 100) / 100;

  if (input.amount > remaining) {
    throw new ValidationError(`Payment ₹${input.amount} exceeds remaining ₹${remaining}`);
  }

  const newStatus = remaining - input.amount <= 0 ? "PAID" : "PARTIALLY_PAID";
  const paymentDate = input.paymentDate ?? new Date();

  const payment = await tx.payment.create({
    data: {
      paymentType: "PAYMENT",
      relatedType: "PURCHASE_BILL",
      relatedId: billId,
      amount: input.amount,
      paymentMode: input.paymentMode as any,
      paymentDate,
      referenceNumber: input.referenceNumber,
      bankAccount: input.bankAccount,
      narration: input.narration,
      status: "COMPLETED",
    },
  });

  await tx.purchaseBill.update({ where: { id: billId }, data: { status: newStatus as any } });
  await tx.vendor.update({
    where: { id: bill.vendorId },
    data: { outstandingBalance: { decrement: input.amount } },
  });

  return payment;
}
