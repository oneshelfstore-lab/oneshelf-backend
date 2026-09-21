import type { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";
import { quarterFor } from "./sellerTds194o.js";
import { getCurrentFinancialYear } from "./invoiceNumbering.js";
import { ManualRail, resolvePayoutRail } from "./payoutRail.js";

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
    select: { id: true, isHouse: true, name: true, pan: true, payoutAccountRef: true },
  });
  if (!seller) throw new NotFoundError("Seller", sellerId);
  if (seller.isHouse) throw new ValidationError("The house store has no commission ledger to pay out.");

  const { payoutHoldDays, payoutRail } = await resolvePayoutSettings();
  const result = await prisma.$transaction((tx) =>
    payoutSellerInTx(tx, sellerId, seller, { ...opts, payoutHoldDays }),
  );

  // ⚠️ OUTSIDE the transaction, always. A rail is a network call to somebody else's service, and
  // holding row locks across one is the rule this codebase already follows for Razorpay refunds.
  // ManualRail does nothing, so today this cannot fail — see payoutRail.ts for what a rail that
  // genuinely sends would need before it can be added here.
  const rail = resolvePayoutRail(payoutRail);
  const sent = await rail.send({
    payoutId: result.payout.id,
    sellerId,
    sellerName: seller.name,
    amount: Number(result.payout.netPaid),
    accountRef: seller.payoutAccountRef ?? null,
  });
  if (sent.reference) {
    await prisma.sellerPayout.update({
      where: { id: result.payout.id },
      data: { reference: sent.reference },
      select: { id: true },
    });
  }

  return { ...result, rail: rail.name, railStatus: sent.status };
}

/**
 * StoreConfig's payout knobs, in one read.
 * payoutHoldDays defaults to 0 (payable on delivery); payoutRail defaults to the rail that moves
 * no money, which is the safe answer when there is no config row to ask.
 */
export async function resolvePayoutSettings(): Promise<{ payoutHoldDays: number; payoutRail: string }> {
  const config = await prisma.storeConfig.findFirst({
    select: { payoutHoldDays: true, payoutRail: true },
  });
  return {
    payoutHoldDays: Math.max(0, config?.payoutHoldDays ?? 0),
    payoutRail: config?.payoutRail ?? ManualRail.name,
  };
}

const r2 = (n: number): number => +n.toFixed(2);

export interface PendingAdjustment {
  id: string;
  /** Signed. Negative recovers money from the seller, positive owes them more. */
  amount: number;
  reason: string;
}

export interface AbsorptionPlan {
  /** Adjustment rows this payout claims. */
  claimIds: string[];
  /** The signed total actually applied to this payout. */
  applied: number;
  /**
   * What a partially-absorbed clawback leaves behind. The claimed row is settled in full and this
   * becomes a NEW unsettled row, so every row stays either fully settled or fully open — no
   * part-settled state, and therefore no second column to keep in step.
   */
  carryForward: { fromId: string; amount: number; reason: string } | null;
}

/**
 * Decide how much of a seller's outstanding adjustments this payout can absorb.
 *
 * ⚠️ A clawback can exceed the payout it lands on, and what happens then is the whole design
 * question. Refusing the payout is the obvious answer and it is wrong: it strands the rest of the
 * seller's money — possibly far more than the debt — until they happen to earn enough to cover it.
 * So the payout absorbs what it can, floors at zero, and the unabsorbed remainder carries forward as
 * a fresh adjustment.
 *
 * ⚠️ That flooring is not cosmetic. Without it a payout could compute a NEGATIVE netPaid, which is
 * not a transfer at all — it is an invoice to the seller, wearing a payout's clothes.
 *
 * Credits are applied before debits, deliberately: a seller owed a correction should receive it in
 * the same batch that recovers a clawback, not watch the clawback eat the batch while their credit
 * waits for the next one.
 */
export function planAdjustmentAbsorption(
  subOrderNet: number,
  adjustments: PendingAdjustment[],
): AbsorptionPlan {
  const claimIds: string[] = [];
  let applied = 0;
  let available = subOrderNet;

  // Credits first — they only ever increase what a debit can then be absorbed against.
  for (const a of adjustments) {
    if (a.amount <= 0) continue;
    claimIds.push(a.id);
    applied = r2(applied + a.amount);
    available = r2(available + a.amount);
  }

  let carryForward: AbsorptionPlan["carryForward"] = null;
  for (const a of adjustments) {
    if (a.amount >= 0) continue;
    if (available <= 0) break; // nothing left to recover against; the rest waits for the next payout
    const owed = -a.amount;
    const absorbed = Math.min(available, owed);
    claimIds.push(a.id);
    applied = r2(applied - absorbed);
    available = r2(available - absorbed);
    const remainder = r2(owed - absorbed);
    if (remainder > 0) {
      carryForward = {
        fromId: a.id,
        amount: -remainder,
        reason: `Carried forward from an earlier clawback: ${a.reason}`,
      };
      break; // available is now 0, so nothing after this could be absorbed either
    }
  }

  return { claimIds, applied, carryForward };
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
  // Adjustments ride along with the sub-orders: a clawback on a slice cancelled after it was paid,
  // or a correction owed to the seller. Oldest first, so a debt cannot be skipped by a newer one.
  // Read BEFORE the empty check, because a seller with no payable orders but a correction owed to
  // them still has something to be paid — and because the refusal below needs to know either way.
  const pending = await tx.subOrderAdjustment.findMany({
    where: { sellerId, settled: false },
    orderBy: { createdAt: "asc" },
    select: { id: true, amount: true, reason: true },
  });
  const pendingCredit = pending.some((a) => Number(a.amount) > 0);

  if (unsettled.length === 0 && !pendingCredit) {
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
  const subOrderNet = +unsettled.reduce((s, o) => s + Number(o.netPayable), 0).toFixed(2);

  const plan = planAdjustmentAbsorption(
    subOrderNet,
    pending.map((a) => ({ id: a.id, amount: Number(a.amount), reason: a.reason })),
  );
  const net = r2(subOrderNet + plan.applied);

  const payout = await tx.sellerPayout.create({
    data: {
      sellerId, grossAmount: gross, commission, tcs, tds,
      adjustmentTotal: plan.applied, netPaid: net,
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
  // Adjustments are claimed with the SAME compare-and-swap, for the same reason: without
  // `settled: false` a concurrent payout re-matches them and recovers the same clawback twice.
  if (plan.claimIds.length > 0) {
    const claimedAdj = await tx.subOrderAdjustment.updateMany({
      where: { id: { in: plan.claimIds }, settled: false },
      data: { settled: true, payoutId: payout.id },
    });
    if (claimedAdj.count !== plan.claimIds.length) {
      throw new ValidationError("Another payout just applied some of these adjustments — re-check the balance and try again.");
    }
  }
  // A clawback bigger than this payout could absorb leaves a remainder. The claimed row above is
  // settled in full and the remainder becomes a NEW open row, so every row is either fully settled
  // or fully open — no part-settled state to keep in step with a second column.
  if (plan.carryForward) {
    await tx.subOrderAdjustment.create({
      data: {
        sellerId,
        kind: "CLAWBACK",
        amount: plan.carryForward.amount,
        reason: plan.carryForward.reason,
      },
      select: { id: true },
    });
  }
  // ⚠️ Decrements by `net`, which already nets the applied adjustments, NOT by subOrderNet.
  // outstandingBalance is the sum of what is still unsettled — sub-orders plus adjustments — and a
  // clawback lowered it when it was written. Decrementing the pre-adjustment figure here would take
  // it down twice and underpay the seller by the clawback on their next payout.
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
    select: {
      autoSellerPayoutEnabled: true,
      autoSellerPayoutMinAmount: true,
      payoutHoldDays: true,
      payoutRail: true,
    },
  });
  if (!config?.autoSellerPayoutEnabled) return { paidCount: 0, skipped: 0 };
  const minAmount = config.autoSellerPayoutMinAmount ?? 500;
  const payoutHoldDays = Math.max(0, config.payoutHoldDays ?? 0);
  // The note used to hardcode "owner still transfers funds manually" — an answer to a question only
  // the rail can answer. It comes from the rail now, so a rail that genuinely sends cannot leave a
  // batch of payouts each claiming a human still has to move the money.
  const rail = resolvePayoutRail(config.payoutRail);

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
      await payoutSeller(c.id, { note: rail.unattendedNote });
      paidCount++;
    } catch {
      // A race (another payout just cleared it) or a genuinely-empty ledger — skip, never fail the cron.
      skipped++;
    }
  }
  return { paidCount, skipped };
}
