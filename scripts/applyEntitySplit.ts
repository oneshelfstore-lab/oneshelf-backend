/**
 * Runbook step 23. Splits the platform from the shop, puts the shop on a commission rate, and
 * closes out the ledger it accumulated while the two were one business.
 *
 * Until now Oneshelf-the-marketplace and Oneshelf-the-kirana-shop were ONE registered business, so
 * the platform charged the shop no commission, collected no Sec-52 TCS on its supplies and withheld
 * no Sec 194-O TDS from it — every one of those would have been the business charging itself.
 * services/entitySplit.ts kept that exemption behind a single flag precisely so that the day it
 * stops being true is a decision somebody takes, on a date they choose, rather than a deploy date.
 *
 * This is that day. From the next order:
 *   • a house sub-order accrues commission at HOUSE_COMMISSION_PCT of its GST-exclusive taxable
 *     value, plus 18% GST on that commission, both withheld from what the shop is owed;
 *   • it accrues Sec-52 TCS at the live statutory rate, which the PLATFORM must now report in
 *     GSTR-8 and remit — a filing obligation that starts with the next house order, not later;
 *   • Seller.outstandingBalance starts growing for the house store, and a payout to it is now
 *     permitted by services/sellerPayout.ts rather than refused;
 *   • a commission invoice (SAC 998599) is raised to the shop when a period is closed.
 *
 * ⚠️ IT DOES NOT REACH BACKWARDS. Every sub-order already written keeps the numbers it was placed
 * with: they were correct under the rule in force at the time, and the shop did not owe commission
 * on an order it took while it WAS the platform.
 *
 * ⚠️ BUT THE PRE-SPLIT HOUSE SLICES CANNOT BE LEFT EXACTLY AS THEY ARE, and this is the part that
 * is easy to miss. They carry netPayable = subtotal, because netPayable is
 * `subtotal − commission − commissionGst − tcs − tds` and all four deductions were zero. That
 * figure was inert while the house was exempt: nothing read it, and orders.ts never credited it to
 * outstandingBalance. The moment the flag flips, two things start reading it and both are wrong:
 *
 *   1. payableSubOrderWhere() selects on `settled: false` + order DELIVERED and NOTHING ELSE, so
 *      8 delivered house slices worth ₹7,463 become payable against an outstandingBalance of 0.00.
 *      One "Pay out" and the platform writes a payout for money it never held and drives the
 *      balance to −7,463. (This is the same ₹7,463 that walked past the missing guard in step 19.)
 *   2. reverseSellerLedgerOnCancel() treats a SETTLED slice as one the seller was already paid for
 *      and raises a CLAWBACK for its full netPayable. So "just mark them settled" does not fix (1)
 *      — it converts it into a debt invented against the shop the first time an old order is
 *      cancelled.
 *
 * So both columns are corrected together: settled = true (nothing here is awaiting settlement) AND
 * netPayable = 0 (nothing here is owed). The second is what makes the clawback path skip them, and
 * it is the truthful figure anyway: the shop invoiced those customers itself under Company and the
 * money was recorded as store revenue at the time. The platform never held it, so it owes none of
 * it. No SellerPayout row is written, because no payment is being made — payoutId stays null, a
 * state the schema already allows.
 *
 * ⚠️ ALL THREE CHANGES ARE ONE TRANSACTION. The flag without a rate is a split that charges
 * nothing; a rate without the flag is a rate nothing reads; and either of those landing while the
 * pre-split ledger is still payable is the ₹7,463 window above. Any one of them alone is a state
 * nobody meant.
 *
 * ⚠️ WHAT IT DOES NOT MOVE: the customer invoice. The shop keeps invoicing its own customers under
 * Company exactly as before — orderInvoice.ts's isStoreOwnSupply is deliberately not gated on this
 * flag. What changes is that a platform entity now charges the shop for selling through it. Read
 * the long note in services/orderInvoice.ts before changing that.
 *
 * Dry run:  railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/applyEntitySplit.ts'
 * Apply:    ... same, with --apply
 *
 * Idempotent: a second run reports the split is already in place and stops.
 */
import { PrismaClient } from "@prisma/client";
import { TCS_RATE_PCT } from "../src/data/taxRates.js";
import { COMMISSION_GST_RATE_PCT } from "../src/data/commissionTax.js";
import { payableSubOrderWhere } from "../src/services/sellerPayout.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const APPLY = process.argv.includes("--apply");
/** The owner's decision, 23 Sep 2026: the shop trades through the platform at 3%. */
const HOUSE_COMMISSION_PCT = 3;
const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);

async function main() {
  console.log(APPLY ? "MODE: APPLY (will write)" : "MODE: DRY RUN (no writes)");

  const cfg = await prisma.storeConfig.findFirst({
    select: { id: true, houseSellerIsSeparateEntity: true, payoutHoldDays: true },
  });
  if (!cfg) throw new Error("No StoreConfig row. Refusing.");

  const house = await prisma.seller.findFirst({
    where: { isHouse: true },
    select: { id: true, name: true, commissionPct: true, outstandingBalance: true, gstin: true, pan: true },
  });
  if (!house) throw new Error("No house seller. Refusing.");

  console.log(`\nbefore:`);
  console.log(`  houseSellerIsSeparateEntity = ${cfg.houseSellerIsSeparateEntity}`);
  console.log(
    `  ${house.name}: commissionPct ${n(house.commissionPct)}%  outstanding ${n(house.outstandingBalance).toFixed(2)}` +
    `  gstin ${house.gstin ?? "not set"}  pan ${house.pan ?? "not set"}`,
  );

  if (cfg.houseSellerIsSeparateEntity && n(house.commissionPct) === HOUSE_COMMISSION_PCT) {
    console.log(`\nAlready split, already at ${HOUSE_COMMISSION_PCT}%. Nothing to do.`);
    return;
  }

  // The pre-split ledger that has to be closed out in the same breath -----------------------
  const hold = Math.max(0, cfg.payoutHoldDays ?? 0);
  const wouldBePayable = await prisma.subOrder.aggregate({
    where: payableSubOrderWhere({ sellerId: house.id, payoutHoldDays: hold }),
    _sum: { netPayable: true },
    _count: { _all: true },
  });
  const openSlices = await prisma.subOrder.aggregate({
    where: { sellerId: house.id, settled: false },
    _sum: { netPayable: true },
    _count: { _all: true },
  });
  console.log(
    `\npre-split house ledger to close out:` +
    `\n  unsettled slices ${openSlices._count._all}  carrying netPayable ${n(openSlices._sum.netPayable).toFixed(2)}` +
    `\n  of which the payout query would pay TODAY: ${wouldBePayable._count._all} slices,` +
    ` ${n(wouldBePayable._sum.netPayable).toFixed(2)}` +
    `\n  against an outstandingBalance of ${n(house.outstandingBalance).toFixed(2)} — money the platform never held.` +
    `\n  → settled = true and netPayable = 0 on all ${openSlices._count._all}. See the note in this file.`,
  );

  // What the very next house order will look like, from a real slice's own numbers ----------
  const slice = await prisma.subOrder.findFirst({
    where: { sellerId: house.id, subtotal: { gt: 0 }, taxableValue: { not: null } },
    select: { subtotal: true, taxableValue: true, order: { select: { orderNumber: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (slice) {
    const sub = n(slice.subtotal);
    const taxable = n(slice.taxableValue);
    const commission = r2((taxable * HOUSE_COMMISSION_PCT) / 100);
    const gst = r2((commission * COMMISSION_GST_RATE_PCT) / 100);
    const tcs = r2((taxable * TCS_RATE_PCT) / 100);
    console.log(
      `\nwhat the next order like ${slice.order.orderNumber} would accrue (gross ${sub.toFixed(2)}, taxable ${taxable.toFixed(2)}):` +
      `\n  commission @${HOUSE_COMMISSION_PCT}%    ${commission.toFixed(2)}` +
      `\n  GST on it @${COMMISSION_GST_RATE_PCT}%     ${gst.toFixed(2)}   withheld, then billed on a commission invoice` +
      `\n  Sec-52 TCS @${TCS_RATE_PCT}%   ${tcs.toFixed(2)}   the platform reports and remits this in GSTR-8` +
      `\n  net to the shop      ${r2(sub - commission - gst - tcs).toFixed(2)}   (was ${sub.toFixed(2)})`,
    );
  }

  if (!APPLY) {
    console.log(`\nWould set houseSellerIsSeparateEntity = true, ${house.name}'s rate to ${HOUSE_COMMISSION_PCT}%,`);
    console.log(`and close out ${openSlices._count._all} pre-split slice(s). Dry run — nothing written.`);
    return;
  }

  let closedOut = 0;
  await prisma.$transaction(async (tx) => {
    await tx.storeConfig.update({
      where: { id: cfg.id },
      data: { houseSellerIsSeparateEntity: true },
      select: { id: true },
    });
    await tx.seller.update({
      where: { id: house.id },
      data: { commissionPct: HOUSE_COMMISSION_PCT },
      select: { id: true },
    });
    // ⚠️ payoutId deliberately stays NULL. Nothing is being paid — these are being marked as having
    // nothing to pay. A SellerPayout row here would claim a transfer that never happened.
    const closed = await tx.subOrder.updateMany({
      where: { sellerId: house.id, settled: false },
      data: { settled: true, netPayable: 0 },
    });
    closedOut = closed.count;
  });

  // Verify by re-reading, not by trusting the writes ------------------------------------------
  const after = await prisma.storeConfig.findFirst({ select: { houseSellerIsSeparateEntity: true } });
  const houseAfter = await prisma.seller.findUnique({
    where: { id: house.id },
    select: { name: true, commissionPct: true, outstandingBalance: true },
  });
  const stillPayable = await prisma.subOrder.aggregate({
    where: payableSubOrderWhere({ sellerId: house.id, payoutHoldDays: hold }),
    _sum: { netPayable: true },
    _count: { _all: true },
  });
  const historical = await prisma.subOrder.count({
    where: { seller: { is: { isHouse: true } }, commissionAmount: { gt: 0 } },
  });

  console.log(`\n--- after ---`);
  console.log(
    `  houseSellerIsSeparateEntity = ${after?.houseSellerIsSeparateEntity}` +
    `  ${after?.houseSellerIsSeparateEntity === true ? "— split" : "  WARNING"}`,
  );
  console.log(
    `  ${houseAfter?.name}: commissionPct ${n(houseAfter?.commissionPct)}%` +
    `  ${n(houseAfter?.commissionPct) === HOUSE_COMMISSION_PCT ? "— as asked" : "  WARNING"}`,
  );
  console.log(`  pre-split slices closed out: ${closedOut}`);
  console.log(
    `  payout query now finds: ${stillPayable._count._all} slice(s), ${n(stillPayable._sum.netPayable).toFixed(2)}` +
    `  ${n(stillPayable._sum.netPayable) === 0 ? "— nothing left to pay for the past" : "  WARNING"}`,
  );
  console.log(
    `  outstandingBalance ${n(houseAfter?.outstandingBalance).toFixed(2)}` +
    `  ${n(houseAfter?.outstandingBalance) === 0 ? "— zero, and now nothing derives against it" : "  WARNING"}`,
  );
  console.log(
    `  house slices carrying a commission: ${historical}` +
    `  ${historical === 0 ? "— none, the past was not restated" : "  WARNING: something reached backwards"}`,
  );
}

main().catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); }).finally(() => prisma.$disconnect());
