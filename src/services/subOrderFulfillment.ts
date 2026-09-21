import type { Prisma, OrderStatus } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";
import { refundPayment } from "./razorpay.js";
import { restoreConsumption } from "./stockBatches.js";

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

// ─── Whole-order cancel: one compare-and-swap, shared by every cancel path ────────────────────
//
// Cancelling an order moves value in three directions at once — stock back onto its batches, the
// customer's money back to source, the seller's accrual out of their balance — so it has to happen
// EXACTLY once. Every cancel site used to read `order.status`, check it, and then write CANCELLED
// unconditionally, which is only safe sequentially: two concurrent cancels (a customer double-tapping
// Cancel, or a customer cancel racing the expiry sweeper / a seller reject) both passed the check and
// both restored stock. ⚠️ restoreConsumption is NOT idempotent — once the first call has deleted the
// consumption rows, the second falls into its legacy "no rows recorded" branch and credits the stock a
// second time — so a double cancel silently inflated inventory.
//
// This is the same guarded-write pattern the rest of the money paths already use (consumeFifo's batch
// decrement, redeemCouponInTx's coupon bump, the wallet debit, markOrderPaid's PENDING→PAID flip,
// claimForAgent). The cancel family simply never adopted it.
//
// ⚠️ ORDERING IS LOAD-BEARING: the CAS runs FIRST and IS the lock. A concurrent transaction blocks on
// this row until we commit, then sees CANCELLED and gets count === 0, so the loser does nothing at all
// — no partial work, nothing to roll back. Restoring stock before the CAS would let the loser credit
// stock it never consumed.

/** Statuses a whole order may legally be cancelled FROM. */
export const CANCELLABLE_STATUSES: OrderStatus[] = ["PLACED", "CONFIRMED"];

/** Why a cancel attempt didn't proceed — the caller turns this into a message or a silent success. */
export type CancelOutcome =
  | "CANCELLED"        // this call won the race and did the work
  | "ALREADY_CANCELLED" // someone else got there first; the customer's intent IS satisfied
  | "NOT_CANCELLABLE";  // too far along (PACKED and beyond), or no such order

/**
 * Cancels an order and restores its stock, exactly once, inside the caller's transaction.
 *
 * Fetches the order's items itself rather than taking them from the caller — the callers all
 * pre-read the order anyway, and a list read before the CAS is a list that may already be stale.
 */
export async function cancelOrderInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  allowedFrom: readonly OrderStatus[] = CANCELLABLE_STATUSES,
): Promise<CancelOutcome> {
  const won = await tx.order.updateMany({
    where: { id: orderId, status: { in: [...allowedFrom] } },
    data: { status: "CANCELLED" },
  });

  if (won.count === 0) {
    // Lost the race, or never eligible. Distinguishing the two matters: a customer whose first tap
    // succeeded and whose network dropped taps again, and reporting "this order can no longer be
    // cancelled" for an order that IS cancelled reads as a failure on a success. Same reasoning as
    // /orders/:id/pay treating an already-PAID order as success rather than a payment error.
    const fresh = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
    return fresh?.status === "CANCELLED" ? "ALREADY_CANCELLED" : "NOT_CANCELLABLE";
  }

  // ⚠️ Skip items belonging to a slice that was ALREADY cancelled — a seller can reject their slice
  // while the order lives on (routes/sellerOrders.ts POST /:id/reject), and that path already restored
  // that slice's stock. Restoring the whole order's items unconditionally (which every cancel path used
  // to do) credited those items a SECOND time on a later whole-order cancel. Items with no slice at all
  // (legacy/unsplit orders) are still restored.
  const items = await tx.orderItem.findMany({
    where: {
      orderId,
      variantId: { not: null },
      OR: [{ subOrderId: null }, { subOrder: { status: { not: "CANCELLED" } } }],
    },
    select: { id: true },
  });
  for (const it of items) {
    await restoreConsumption(tx, { orderItemId: it.id });
  }

  return "CANCELLED";
}

// restoreConsumption walks every batch each item drew from and recomputes the variant's rollup cost,
// so a large order's cancel is many sequential round-trips — the same shape that made the catalog
// editor's many-size save blow Prisma's 5s default interactive-transaction timeout as an opaque
// P2028 ("unexpected error" on a cancel that looked fine). Matches CATALOG_TX_OPTIONS.
const CANCEL_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

/** [cancelOrderInTx] in its own transaction, for the callers that aren't already inside one. */
export async function cancelOrder(
  orderId: string,
  allowedFrom: readonly OrderStatus[] = CANCELLABLE_STATUSES,
): Promise<CancelOutcome> {
  return prisma.$transaction((tx) => cancelOrderInTx(tx, orderId, allowedFrom), CANCEL_TX_OPTIONS);
}

/**
 * Claims the right to refund this order's captured payment, exactly once.
 *
 * The flip to REFUND_INITIATED used to be an unconditional `update`, which claimed nothing: a cancel
 * could read paymentStatus PAID at the same moment reconcileOrderPayment did (it refunds a capture
 * that landed against an already-cancelled order) and both would call Razorpay. Making the write
 * itself the claim closes that window for every caller at once.
 *
 * Returns true only for the caller that must now actually call the gateway. ⚠️ Call the gateway
 * OUTSIDE any transaction — never hold row locks across a network call.
 */
export async function claimRefund(orderId: string, razorpayPaymentId: string): Promise<boolean> {
  const claimed = await prisma.order.updateMany({
    where: { id: orderId, paymentStatus: "PAID" },
    data: { paymentStatus: "REFUND_INITIATED", razorpayPaymentId },
  });
  return claimed.count === 1;
}

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

  // Already paid out ⇒ the money has left, so the balance cannot simply be reversed. It becomes a
  // SubOrderAdjustment instead (written inside the claim below), which the seller's next payout
  // absorbs automatically. The flag is still returned so the Complaint can say what happened.
  const clawbackBlocked = sub.settled && !sub.seller.isHouse && Number(sub.netPayable) > 0;

  // ⚠️ The slice flip is a COMPARE-AND-SWAP, not a plain update, and it gates everything below it.
  // The `sub.status === "CANCELLED"` check above was read outside this transaction, so two concurrent
  // rejects of the same slice both passed it and both decremented the seller's outstandingBalance,
  // both reduced Order.totalAmount, and both fired a partial Razorpay refund. Claiming the row here
  // means only one caller ever proceeds. See cancelOrderInTx for the same pattern on the whole order.
  let claimedSlice = false;
  await prisma.$transaction(async (tx) => {
    const flipped = await tx.subOrder.updateMany({
      where: { id: sub.id, status: { not: "CANCELLED" } },
      data: { status: "CANCELLED" },
    });
    if (flipped.count === 0) return; // another path already unwound this slice
    claimedSlice = true;

    // Stock comes back INSIDE the claim, not before it. The caller used to restore in a separate
    // transaction ahead of this one, so two concurrent rejects of the same slice both restored (both
    // passed the caller's status check) even though only one won the claim — and restoreConsumption
    // double-credits on a second call. Fetched here rather than passed in for the same reason
    // cancelOrderInTx fetches its own: a list read before the claim may already be stale.
    const sliceItems = await tx.orderItem.findMany({
      where: { subOrderId: sub.id, variantId: { not: null } },
      select: { id: true },
    });
    for (const it of sliceItems) {
      await restoreConsumption(tx, { orderItemId: it.id });
    }

    // Unpaid ⇒ just back the accrual out. Already paid ⇒ the money has gone, so it becomes a debt
    // the next payout recovers. Either way the seller's balance drops by the same amount, and it
    // happens INSIDE the claim so a lost race cannot write a second clawback for the same slice.
    if (!sub.seller.isHouse && Number(sub.netPayable) > 0) {
      if (sub.settled) {
        await tx.subOrderAdjustment.create({
          data: {
            sellerId: sub.sellerId,
            subOrderId: sub.id,
            kind: "CLAWBACK",
            amount: -Number(sub.netPayable),
            reason: `Seller rejected their items on order ${order.id} after being paid for them`,
          },
          select: { id: true },
        });
      }
      await tx.seller.update({
        where: { id: sub.sellerId },
        data: { outstandingBalance: { decrement: Number(sub.netPayable) } },
        select: { id: true },
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
  }, CANCEL_TX_OPTIONS);

  // Outside the transaction — an external gateway call must never hold a DB lock, and a refund
  // failure must not roll back the cancellation (the goods are already off the order).
  let refundToSource = 0;
  if (!claimedSlice) {
    // Lost the race — the winner already refunded this slice. Report nothing moved.
    return { refunded: 0, refundToSource: 0, storeCreditPortion: 0, clawbackBlocked: false };
  }
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
      // ⚠️ Per-slice COMPARE-AND-SWAP, and the decrement is gated on winning it. `subs` was read
      // outside this transaction, so a bulk updateMany + unconditional decrement let two concurrent
      // cancels of the same order BOTH reverse the same accrual — the seller's outstandingBalance
      // went down twice and they were underpaid by exactly one order. Claiming each slice makes the
      // reversal exactly-once no matter how many paths call this.
      for (const s of subs) {
        const flipped = await tx.subOrder.updateMany({
          where: { id: s.id, status: { not: "CANCELLED" } },
          data: { status: "CANCELLED" },
        });
        if (flipped.count === 0) continue; // already reversed by another path
        if (s.seller.isHouse || Number(s.netPayable) <= 0) continue;
        // ⚠️ A settled slice used to be SKIPPED here entirely — silently, with no warning anywhere,
        // unlike the single-slice path which at least flagged it on a Complaint. The seller kept
        // money for an order that was cancelled and nothing recorded that it had happened. It is a
        // clawback now: a debt their next payout recovers automatically.
        if (s.settled) {
          await tx.subOrderAdjustment.create({
            data: {
              sellerId: s.sellerId,
              subOrderId: s.id,
              kind: "CLAWBACK",
              amount: -Number(s.netPayable),
              reason: `Order ${orderId} was cancelled after this seller had been paid for it`,
            },
            select: { id: true },
          });
        }
        // select: only the id — this write's result is discarded, but without a select Prisma
        // emits RETURNING for every column in the model, so a client that is even briefly ahead of
        // the database (a schema edit not yet migrated) fails the whole transaction with P2022.
        // That is exactly what silently rolled back scripts/repairLegacyAccrual.ts.
        await tx.seller.update({
          where: { id: s.sellerId },
          data: { outstandingBalance: { decrement: Number(s.netPayable) } },
          select: { id: true },
        });
      }
    });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "seller ledger reversal failed", orderId, err: String(e) }));
  }
}
