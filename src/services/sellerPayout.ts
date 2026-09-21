import type { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";
import { quarterFor } from "./sellerTds194o.js";
import { getCurrentFinancialYear } from "./invoiceNumbering.js";

/**
 * Which sub-orders a seller may actually be PAID for, as one Prisma filter.
 *
 * Exported and shared so the payout itself and the cron's eligibility check ask the identical
 * question — two copies of this predicate is how a seller gets paid by one path for something the
 * other path considers unpayable.
 *
 * ⚠️ `order.status = DELIVERED` is the point of this filter. Until it existed, a slice became
 * payable the moment the order was PLACED, so a seller could be paid in full for goods still in a
 * rider's bag — or still sitting unpacked on their own counter. Accrual at placement is right (the
 * platform genuinely owes them once the order is committed); paying it out before the customer has
 * the goods is not, because a cancellation after payment has to be clawed back by hand.
 *
 * ⚠️ It also subsumes the older `order.status != CANCELLED` guard, which is still doing real work:
 * orders cancelled BEFORE the ledger reversal existed left their slices active, so filtering on the
 * slice's own status alone would keep paying them out. DELIVERED is strictly narrower, so that
 * protection survives rather than being dropped.
 *
 * `payoutHoldDays` gives returns a window to land before the money leaves. 0 — the default — means
 * payable as soon as it is delivered, and deliberately adds NO deliveredAt condition at all: a
 * delivered order with a null deliveredAt (none exist today, but nothing enforces that) would
 * otherwise become permanently unpayable the day someone sets a hold.
 */
export function payableSubOrderWhere(opts: {
  sellerId?: string;
  payoutHoldDays: number;
  now?: Date;
}): Prisma.SubOrderWhereInput {
  const { sellerId, payoutHoldDays } = opts;
  const now = opts.now ?? new Date();
  const held = payoutHoldDays > 0;
  return {
    ...(sellerId ? { sellerId } : {}),
    settled: false,
    // The seller rejected their own slice of an order that went on to be delivered by others.
    status: { not: "CANCELLED" },
    order: {
      status: "DELIVERED",
      ...(held ? { deliveredAt: { lte: new Date(now.getTime() - payoutHoldDays * 86_400_000) } } : {}),
    },
  };
}

// Sums every PAYABLE SubOrder for a seller, creates a SellerPayout covering them, marks them
// settled, and decrements the running balance. Shared by the owner's manual "Pay out" action
// (ownerSellers.ts) and the auto-payout cron (runAutoSellerPayouts below) so both go through the
// exact same ledger math — no separate code path to drift.
export async function payoutSeller(
  sellerId: string,
  opts: { mode?: string | null; reference?: string | null; note?: string | null } = {},
) {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, isHouse: true, name: true, pan: true },
  });
  if (!seller) throw new NotFoundError("Seller", sellerId);
  if (seller.isHouse) throw new ValidationError("The house store has no commission ledger to pay out.");

  const payoutHoldDays = await resolvePayoutHoldDays();
  return prisma.$transaction((tx) => payoutSellerInTx(tx, sellerId, seller, { ...opts, payoutHoldDays }));
}

/** StoreConfig.payoutHoldDays, defaulting to 0 (payable on delivery) if there is no config row. */
export async function resolvePayoutHoldDays(): Promise<number> {
  const config = await prisma.storeConfig.findFirst({ select: { payoutHoldDays: true } });
  return Math.max(0, config?.payoutHoldDays ?? 0);
}

/**
 * The ledger write itself, with the transaction injected.
 *
 * Split out from [payoutSeller] only so the exactly-once claim below can be exercised directly —
 * every way it can be wrong moves real money and is silent on every screen.
 */
export async function payoutSellerInTx(
  tx: Prisma.TransactionClient,
  sellerId: string,
  seller: { id: string; name: string; pan: string | null },
  opts: {
    mode?: string | null;
    reference?: string | null;
    note?: string | null;
    payoutHoldDays?: number;
    now?: Date;
  } = {},
) {
  const payoutHoldDays = Math.max(0, opts.payoutHoldDays ?? 0);
  // See payableSubOrderWhere — delivered only, plus any configured hold. reverseSellerLedgerOnCancel
  // and cancelSubOrderAndRefund back a cancelled accrual out of outstandingBalance separately; this
  // is what keeps the payout itself honest.
  const unsettled = await tx.subOrder.findMany({
    where: payableSubOrderWhere({ sellerId, payoutHoldDays, now: opts.now }),
    select: { id: true, subtotal: true, commissionAmount: true, tcsAmount: true, tdsAmount: true, netPayable: true },
  });
  if (unsettled.length === 0) {
    // ⚠️ "Nothing to pay out" is now ambiguous in a way it never used to be: the owner's screen
    // shows outstandingBalance, which still counts everything accrued and unpaid INCLUDING orders
    // in flight. Without naming the held amount, a seller showing ₹693 owed and refusing to pay
    // reads as a broken button rather than as the guard doing its job.
    const held = await tx.subOrder.aggregate({
      where: { sellerId, settled: false, status: { not: "CANCELLED" }, order: { status: { not: "CANCELLED" } } },
      _sum: { netPayable: true },
      _count: { _all: true },
    });
    const heldNet = Number(held._sum?.netPayable ?? 0);
    if (heldNet > 0) {
      throw new ValidationError(
        `Nothing payable yet — ₹${heldNet.toFixed(2)} across ${held._count?._all ?? 0} order(s) has not been delivered` +
          (payoutHoldDays > 0 ? `, or is inside the ${payoutHoldDays}-day hold.` : ".") +
          " It becomes payable once the customer has the goods.",
      );
    }
    throw new ValidationError("Nothing to pay out — no unsettled orders.");
  }

  const gross = +unsettled.reduce((s, o) => s + Number(o.subtotal), 0).toFixed(2);
  const commission = +unsettled.reduce((s, o) => s + Number(o.commissionAmount), 0).toFixed(2);
  const tcs = +unsettled.reduce((s, o) => s + Number(o.tcsAmount), 0).toFixed(2);
  const tds = +unsettled.reduce((s, o) => s + Number(o.tdsAmount), 0).toFixed(2);
  const net = +unsettled.reduce((s, o) => s + Number(o.netPayable), 0).toFixed(2);

  const payout = await tx.sellerPayout.create({
    data: {
      sellerId, grossAmount: gross, commission, tcs, tds, netPaid: net,
      mode: opts.mode ?? null, reference: opts.reference ?? null, note: opts.note ?? null,
    },
  });
  // ⚠️ COMPARE-AND-SWAP — `settled: false` is what makes a payout exactly-once, and its absence is
  // how one set of orders got paid twice. The read above is an MVCC snapshot, so two concurrent
  // payouts for one seller (the owner tapping "Pay out" while the daily runAutoSellerPayouts cron is
  // mid-run — or simply a retried cron ping) both saw the same unsettled list. Filtering the update
  // on id ALONE meant the second one, once it unblocked on the first's row locks, re-matched every
  // row and wrote them again, then decremented outstandingBalance a SECOND time: two SellerPayout
  // rows for one set of orders, and the seller short by the payout amount.
  //
  // A short claim means someone else settled part of this set first, so the totals computed above are
  // already wrong. Throwing rolls the whole payout back — the owner clicks again, or the cron picks it
  // up next run. For money, a clean retryable error beats recording a partly-correct transfer.
  const claimed = await tx.subOrder.updateMany({
    where: { id: { in: unsettled.map((o) => o.id) }, settled: false },
    data: { settled: true, payoutId: payout.id },
  });
  if (claimed.count !== unsettled.length) {
    throw new ValidationError("Another payout just settled some of these orders — re-check the balance and try again.");
  }
  await tx.seller.update({
    where: { id: sellerId },
    data: { outstandingBalance: { decrement: net } },
    select: { id: true },
  });

  // Feed the existing manual TDS register (routes/tdsRecords.ts) so a Sec 194-O withholding shows
  // up alongside vendor/salary TDS instead of being invisible outside the SubOrder rows. One row
  // per payout batch (not per SubOrder — a batch can cover many small orders, and the register is
  // meant for quarter-level filing, not order-level noise). `tdsRate` here is the EFFECTIVE rate
  // for this batch (tds / gross) — it can differ from StoreConfig.tds194oRatePct when the batch
  // straddles the ₹5L threshold, so treat it as a derived figure for the register, not a legal rate.
  if (tds > 0) {
    const now = new Date();
    await tx.tdsRecord.create({
      data: {
        deducteeType: "SELLER",
        deducteeId: sellerId,
        deducteeName: seller.name,
        deducteePan: seller.pan,
        section: "194O",
        paymentDate: now,
        paymentAmount: gross,
        tdsRate: +((tds / gross) * 100).toFixed(2),
        tdsAmount: tds,
        depositedToGovt: false,
        quarter: quarterFor(now),
        financialYear: getCurrentFinancialYear(now),
        returnFiled: false,
      },
    });
  }

  return { payout, count: claimed.count };
}

// Auto-payout run: gated by StoreConfig.autoSellerPayoutEnabled (off by default — manual payout, as
// before). For every active non-house seller whose unsettled netPayable is at least
// autoSellerPayoutMinAmount, creates a SellerPayout (mode="AUTO") via the same ledger math as the
// owner's manual "Pay out" button. This does NOT move real money — same as the manual flow, it only
// records that a payout happened (bank transfer/UPI still done by the owner outside the app); the
// point is to stop unpaid balances sitting indefinitely just because nobody remembered to click.
export async function runAutoSellerPayouts(): Promise<{ paidCount: number; skipped: number }> {
  const config = await prisma.storeConfig.findFirst({
    select: { autoSellerPayoutEnabled: true, autoSellerPayoutMinAmount: true, payoutHoldDays: true },
  });
  if (!config?.autoSellerPayoutEnabled) return { paidCount: 0, skipped: 0 };
  const minAmount = config.autoSellerPayoutMinAmount ?? 500;
  const payoutHoldDays = Math.max(0, config.payoutHoldDays ?? 0);

  // ⚠️ Gated on the PAYABLE sum, not on Seller.outstandingBalance, and the distinction is new.
  // The two used to be the same number. Now that undelivered orders are held back, a seller can owe
  // ₹700 with only ₹350 of it payable — so keeping the old balance-based gate would fire the cron
  // for a seller whose payable amount is under the minimum and transfer it anyway, quietly turning
  // "don't bother with transfers under ₹500" into a rule that means nothing.
  const payable = await prisma.subOrder.groupBy({
    by: ["sellerId"],
    where: payableSubOrderWhere({ payoutHoldDays }),
    _sum: { netPayable: true },
  });
  const overMinimum = new Set(
    payable.filter((p) => Number(p._sum.netPayable ?? 0) >= minAmount).map((p) => p.sellerId),
  );
  if (overMinimum.size === 0) return { paidCount: 0, skipped: 0 };

  const candidates = await prisma.seller.findMany({
    where: { isHouse: false, isActive: true, status: "APPROVED", id: { in: [...overMinimum] } },
    select: { id: true },
  });

  let paidCount = 0;
  let skipped = 0;
  for (const c of candidates) {
    try {
      // mode stays null here — it documents the TRANSFER method (bank/UPI/cash), which an automatic
      // run doesn't know; the note records that this was cron-triggered, not owner-clicked.
      await payoutSeller(c.id, { note: "Automatic scheduled payout (owner still transfers funds manually)" });
      paidCount++;
    } catch {
      // A race (another payout just cleared it) or a genuinely-empty ledger — skip, never fail the cron.
      skipped++;
    }
  }
  return { paidCount, skipped };
}
