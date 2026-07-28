import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";
import { refundPayment } from "./razorpay.js";

// Local, like cartPricing/referralRewards/subscriptionEngine/taxEngine each keep their own — this
// codebase duplicates the one-liner rather than sharing it.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// A parent order at PACKED must imply "every seller's slice is physically ready", because the delivery
// agent's collection run refuses to collect a stop whose SubOrder isn't PACKED
// (routes/delivery.ts POST /:id/collect/:subOrderId → "Seller hasn't packed these items yet").
//
// The seller-driven path already holds that invariant (maybeAdvanceParentOrder in routes/sellerOrders.ts
// only advances once every slice is PACKED/COLLECTED/CANCELLED). The owner/admin status routes did NOT,
// so forcing an order to PACKED while a seller was still preparing DEADLOCKED it: the agent couldn't
// collect that stop, the order could never auto-advance to OUT_FOR_DELIVERY, and the owner is not exempt
// from the collect-time check either — nobody could move it.

// A slice is "ready" once the seller is done with it one way or another; CANCELLED counts because a
// rejected slice is skipped by the collection run rather than collected.
const READY_STATUSES = ["PACKED", "COLLECTED", "CANCELLED"];

export type SliceReadiness = { status: string; sellerName: string; isHouse: boolean };

/**
 * The names of the sellers still blocking collection, in order.
 *
 * ⚠️ House slices are deliberately exempt: they sit at the dispatch point and the collect route
 * auto-collects them regardless of status, so they can never block the run. Without this exemption the
 * guard would block every ordinary single-store order whose house slice nobody bothered to tick.
 */
export function unpackedSellers(slices: SliceReadiness[]): string[] {
  return slices
    .filter((s) => !s.isHouse && !READY_STATUSES.includes(s.status))
    .map((s) => s.sellerName);
}

export function packBlockerMessage(names: string[]): string {
  return (
    `${names.join(", ")} ${names.length === 1 ? "hasn't" : "haven't"} packed their items yet, so the ` +
    "delivery partner can't collect from them. Wait for them, or mark their part packed on their behalf."
  );
}

export async function assertSellersPacked(orderId: string): Promise<void> {
  const rows = await prisma.subOrder.findMany({
    where: { orderId },
    select: { status: true, seller: { select: { name: true, isHouse: true } } },
  });
  const blocking = unpackedSellers(
    rows.map((r) => ({ status: r.status, sellerName: r.seller.name, isHouse: r.seller.isHouse })),
  );
  if (blocking.length > 0) throw new ValidationError(packBlockerMessage(blocking));
}

/**
 * The escape hatch the guard needs: a seller who has physically bagged the goods but never tapped
 * "packed" in their app would otherwise strand the order at CONFIRMED forever. Same write the seller's
 * own PATCH /status does, attributed to the owner. Also the recovery path for orders already stuck at
 * PACKED from before the guard existed.
 *
 * Deliberately does NOT auto-advance the parent order (maybeAdvanceParentOrder lives in the seller route
 * and is not shared): the owner is on the dispatch board and advances it with the button that's already
 * there — which now passes assertSellersPacked.
 */
export async function markSubOrderPackedByOwner(
  orderId: string,
  subOrderId: string,
): Promise<{ subOrderId: string; sellerName: string; status: string }> {
  const sub = await prisma.subOrder.findFirst({
    where: { id: subOrderId, orderId },
    select: { id: true, status: true, seller: { select: { name: true } } },
  });
  if (!sub) throw new NotFoundError("SubOrder", subOrderId);

  if (sub.status === "CANCELLED") {
    throw new ValidationError(`${sub.seller.name} rejected this order — their items can't be packed.`);
  }
  // Idempotent: already PACKED (or COLLECTED) is a no-op success.
  if (sub.status === "PLACED" || sub.status === "ACCEPTED") {
    await prisma.subOrder.update({
      where: { id: sub.id },
      data: { status: "PACKED", packedAt: new Date() },
    });
  }

  return { subOrderId: sub.id, sellerName: sub.seller.name, status: "PACKED" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation — reversing a slice's money
//
// The commission ledger is accrued at PLACEMENT (routes/orders.ts bumps Seller.outstandingBalance by
// netPayable the moment the order is created), but nothing ever reversed it. So a cancelled slice —
// and every slice of a fully cancelled order — stayed on the seller's balance AND was picked up by
// payoutSeller (its query had no status filter): the store paid sellers for goods nobody received.
// Separately, a seller rejecting their slice of a MULTI-seller order left the customer charged in
// full for items they'd never get; only the last-seller-standing case refunded anything.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one seller's slice is worth to the customer, net of every order-level discount.
 *
 * Derived from the STORED totals rather than re-deriving the discount stack (coupon + loyalty + BOGO
 * are folded together differently across paths), so it stays exact whatever mix applied:
 *   goodsCharged = totalAmount + walletApplied − deliveryCharge   (i.e. afterDiscount)
 *
 * ⚠️ Delivery is deliberately NOT refunded — the trip still happens for the sellers who remain. On a
 * whole-order cancel the customer gets the full totalAmount back through the existing path instead.
 */
export function sliceRefundValue(
  order: { subtotal: number; totalAmount: number; walletApplied: number; deliveryCharge: number },
  sliceSubtotal: number,
): number {
  if (order.subtotal <= 0 || sliceSubtotal <= 0) return 0;
  const goodsCharged = order.totalAmount + order.walletApplied - order.deliveryCharge;
  if (goodsCharged <= 0) return 0;
  const share = Math.min(sliceSubtotal / order.subtotal, 1);
  return round2(goodsCharged * share);
}

/**
 * How that value is actually returned. Cash first (only ever up to what we really charged), and the
 * remainder is whatever the customer's store credit covered.
 */
export function splitRefundTenders(
  value: number,
  order: { totalAmount: number; walletApplied: number },
): { cash: number; wallet: number } {
  const cash = round2(Math.min(value, Math.max(order.totalAmount, 0)));
  const wallet = round2(Math.min(value - cash, Math.max(order.walletApplied, 0)));
  return { cash, wallet: wallet > 0 ? wallet : 0 };
}

/**
 * Cancel ONE seller's slice of a multi-seller order and make the customer whole for it.
 *
 * - marks the slice CANCELLED and reverses its commission accrual (unless already paid out),
 * - drops the order's totalAmount by the refunded amount, so a COD agent collects less and a prepaid
 *   order's remaining value stays honest,
 * - refunds a prepaid order's share to source,
 * - cancels that seller's own invoice (invoices are per-SubOrder since Phase 6).
 *
 * Stock restore stays with the caller — routes/sellerOrders.ts already does it per item, and it needs
 * the item rows this function doesn't load.
 */
export async function cancelSubOrderAndRefund(
  orderId: string,
  subOrderId: string,
): Promise<{ refunded: number; refundToSource: number; storeCreditPortion: number; clawbackBlocked: boolean }> {
  const sub = await prisma.subOrder.findFirst({
    where: { id: subOrderId, orderId },
    select: {
      id: true, status: true, subtotal: true, netPayable: true, settled: true, sellerId: true,
      seller: { select: { isHouse: true } },
      order: {
        select: {
          id: true, subtotal: true, totalAmount: true, walletApplied: true, deliveryCharge: true,
          paymentStatus: true, razorpayPaymentId: true, customerId: true,
        },
      },
    },
  });
  if (!sub) throw new NotFoundError("SubOrder", subOrderId);
  if (sub.status === "CANCELLED") {
    return { refunded: 0, refundToSource: 0, storeCreditPortion: 0, clawbackBlocked: false };
  }

  const order = sub.order;
  const value = sliceRefundValue(
    {
      subtotal: Number(order.subtotal),
      totalAmount: Number(order.totalAmount),
      walletApplied: Number(order.walletApplied),
      deliveryCharge: Number(order.deliveryCharge),
    },
    Number(sub.subtotal),
  );
  // ponytail: the store-credit share is reported, not auto-credited. WalletTransaction is
  // @@unique([orderId, type]), so writing an ORDER_REFUND row here would consume the slot and make a
  // later whole-order cancel's refund silently no-op (P2002). Returned so the caller can put it on the
  // Complaint for the owner to settle. Give partial refunds their own txn type if this gets common.
  const { cash, wallet: storeCreditPortion } = splitRefundTenders(value, {
    totalAmount: Number(order.totalAmount),
    walletApplied: Number(order.walletApplied),
  });

  // Already paid out ⇒ the money has left; reversing the balance would just make the seller's next
  // payout absorb it silently. Surfaced to the caller so it lands in the Complaint instead.
  const clawbackBlocked = sub.settled && !sub.seller.isHouse && Number(sub.netPayable) > 0;

  await prisma.$transaction(async (tx) => {
    await tx.subOrder.update({ where: { id: sub.id }, data: { status: "CANCELLED" } });

    if (!sub.seller.isHouse && !sub.settled) {
      await tx.seller.update({
        where: { id: sub.sellerId },
        data: { outstandingBalance: { decrement: Number(sub.netPayable) } },
      });
    }

    if (cash > 0) {
      await tx.order.update({
        where: { id: order.id },
        data: { totalAmount: Math.max(round2(Number(order.totalAmount) - cash), 0) },
      });
    }

    // Per-SubOrder invoice (Phase 6) — void this seller's, leave the others alone.
    await tx.invoice.updateMany({
      where: { subOrderId: sub.id, status: { not: "CANCELLED" } },
      data: { status: "CANCELLED" },
    });
  });

  // Outside the transaction — an external gateway call must never hold a DB lock, and a refund
  // failure must not roll back the cancellation (the goods are already off the order).
  let refundToSource = 0;
  if (cash > 0 && order.paymentStatus === "PAID" && order.razorpayPaymentId) {
    try {
      await refundPayment(order.razorpayPaymentId, Math.round(cash * 100));
      refundToSource = cash;
    } catch (e) {
      console.error("Partial refund failed for order", order.id, "subOrder", sub.id, e);
    }
  }

  return { refunded: value, refundToSource, storeCreditPortion, clawbackBlocked };
}

/**
 * Whole-order cancel: cancel every remaining slice and reverse its commission accrual.
 *
 * Sits next to refundWalletOnCancel at every cancel site (customer, owner, admin, expiry sweeper) and
 * is guarded on status the same way, so it's safe to call unconditionally and is idempotent — a second
 * run finds no non-CANCELLED slices. The customer's own refund is the caller's existing full-amount
 * path; this only settles what the store owes its sellers.
 */
export async function reverseSellerLedgerOnCancel(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!order || order.status !== "CANCELLED") return;

  const subs = await prisma.subOrder.findMany({
    where: { orderId, status: { not: "CANCELLED" } },
    select: { id: true, sellerId: true, netPayable: true, settled: true, seller: { select: { isHouse: true } } },
  });
  if (subs.length === 0) return;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.subOrder.updateMany({
        where: { id: { in: subs.map((s) => s.id) } },
        data: { status: "CANCELLED" },
      });
      for (const s of subs) {
        if (s.seller.isHouse || s.settled) continue;
        await tx.seller.update({
          where: { id: s.sellerId },
          data: { outstandingBalance: { decrement: Number(s.netPayable) } },
        });
      }
    });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "seller ledger reversal failed", orderId, err: String(e) }));
  }
}
