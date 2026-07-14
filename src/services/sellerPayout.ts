import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";
import { quarterFor } from "./sellerTds194o.js";
import { getCurrentFinancialYear } from "./invoiceNumbering.js";

// Sums every unsettled SubOrder for a seller, creates a SellerPayout covering them, marks them
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

  return prisma.$transaction(async (tx) => {
    const unsettled = await tx.subOrder.findMany({
      where: { sellerId, settled: false },
      select: { id: true, subtotal: true, commissionAmount: true, tcsAmount: true, tdsAmount: true, netPayable: true },
    });
    if (unsettled.length === 0) throw new ValidationError("Nothing to pay out — no unsettled orders.");

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
    await tx.subOrder.updateMany({ where: { id: { in: unsettled.map((o) => o.id) } }, data: { settled: true, payoutId: payout.id } });
    await tx.seller.update({ where: { id: sellerId }, data: { outstandingBalance: { decrement: net } } });

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

    return { payout, count: unsettled.length };
  });
}

// Auto-payout run: gated by StoreConfig.autoSellerPayoutEnabled (off by default — manual payout, as
// before). For every active non-house seller whose unsettled netPayable is at least
// autoSellerPayoutMinAmount, creates a SellerPayout (mode="AUTO") via the same ledger math as the
// owner's manual "Pay out" button. This does NOT move real money — same as the manual flow, it only
// records that a payout happened (bank transfer/UPI still done by the owner outside the app); the
// point is to stop unpaid balances sitting indefinitely just because nobody remembered to click.
export async function runAutoSellerPayouts(): Promise<{ paidCount: number; skipped: number }> {
  const config = await prisma.storeConfig.findFirst({ select: { autoSellerPayoutEnabled: true, autoSellerPayoutMinAmount: true } });
  if (!config?.autoSellerPayoutEnabled) return { paidCount: 0, skipped: 0 };
  const minAmount = config.autoSellerPayoutMinAmount ?? 500;

  const candidates = await prisma.seller.findMany({
    where: { isHouse: false, isActive: true, status: "APPROVED", outstandingBalance: { gte: minAmount } },
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
