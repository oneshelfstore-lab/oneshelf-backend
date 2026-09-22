/**
 * One-off repair for the sub-orders withheld at the superseded 1% TCS rate (runbook step 06).
 *
 * Notification 15/2024-Central Tax cut Sec-52 TCS from 1% to 0.5% with effect from 10 July 2024.
 * Every order this platform has ever taken was placed well after that date, so these rows are not
 * "correct at the time" — they withheld roughly twice what the law asked for from a seller who has
 * not been paid yet. Changing the constant fixes the next order; this fixes the ones already written.
 *
 * ⚠️ WHY THIS IS SAFE TO RUN, and the two conditions that make it so:
 *   1. NOTHING HAS BEEN PAID OUT. Every affected slice is settled = false, so the over-withholding
 *      is an accrual nobody has acted on. The script REFUSES if it finds a settled one — money that
 *      has actually moved needs a clawback and a conversation, not a silent column edit.
 *   2. NOTHING HAS BEEN FILED. A GSTR-8 already submitted to the government must be corrected by
 *      amendment, not by rewriting the rows it was built from. The script REFUSES if any affected
 *      row falls inside a filed period.
 * Both are checked at run time, not assumed. The day either stops being true, this script stops.
 *
 * ⚠️ It moves Seller.outstandingBalance by exactly the sum of the netPayable deltas of the rows the
 * balance currently counts. It deliberately does NOT reconcile that balance to its derived value:
 * there is a known unrelated drift on it (see scripts/repairLegacyAccrual.ts) and papering over that
 * here would hide a second problem inside the fix for this one. The drift must be the same after.
 *
 * Dry run:  railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/repairTcsRate.ts'
 * Apply:    ... same, with --apply
 *
 * Idempotent: it only selects LIVE rows still carrying tcsRatePct = 1, so a second run finds nothing.
 */
import { PrismaClient } from "@prisma/client";
import { TCS_RATE_PCT } from "../src/data/taxRates.js";
import { RETURN_TYPES, periodOf, filedAt } from "../src/services/filedPeriods.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const APPLY = process.argv.includes("--apply");
const SUPERSEDED_RATE = 1;
const n = (v: unknown) => Number(v ?? 0);
/** The split's own rounding. Not round2 — see services/sellerSplit.ts. */
const r2 = (v: number) => +v.toFixed(2);

/** The balance the ledger derives from live slices — the same predicate payouts use. */
async function derivedOwed(sellerId: string): Promise<number> {
  const agg = await prisma.subOrder.aggregate({
    _sum: { netPayable: true },
    where: { sellerId, settled: false, status: { not: "CANCELLED" }, order: { status: { not: "CANCELLED" } } },
  });
  return r2(n(agg._sum.netPayable));
}

async function main() {
  console.log(APPLY ? "MODE: APPLY (will write)" : "MODE: DRY RUN (no writes)");
  console.log(`Correcting ${SUPERSEDED_RATE}% -> ${TCS_RATE_PCT}%\n`);
  if (TCS_RATE_PCT >= SUPERSEDED_RATE) {
    throw new Error(`TCS_RATE_PCT is ${TCS_RATE_PCT}; this script only makes sense once it is below ${SUPERSEDED_RATE}.`);
  }

  // ⚠️ CANCELLED SLICES ARE DELIBERATELY LEFT AT 1%, and that is not laziness.
  //
  // A cancelled slice's TCS was never remitted (GSTR-8 excludes cancelled orders) and its netPayable
  // is never paid, so there is no wrong number to correct. What there IS is a booby trap: two of
  // them - ONS/2627/00013 and ONS/2627/00026 - carry an accrual that was never reversed, and their
  // original netPayable of 118.44 + 67.68 is exactly the 186.12 still sitting in bansal stationary's
  // outstandingBalance. scripts/repairLegacyAccrual.ts reverses that by reading netPayable off the
  // row. Correcting these rows first would make it decrement 187.11 against an accrual of 186.12 and
  // leave the seller 0.99 short - a second bug, planted inside the fix for the first.
  //
  // They are counted and reported rather than filtered out silently.
  const rows = await prisma.subOrder.findMany({
    where: {
      tcsRatePct: SUPERSEDED_RATE,
      tcsAmount: { gt: 0 },
      status: { not: "CANCELLED" },
      order: { is: { status: { not: "CANCELLED" } } },
    },
    select: {
      id: true, sellerId: true, settled: true, status: true, createdAt: true,
      subtotal: true, taxableValue: true, commissionAmount: true, tcsAmount: true,
      tdsAmount: true, netPayable: true,
      seller: { select: { name: true } },
      order: { select: { orderNumber: true, status: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const cancelled = await prisma.subOrder.count({
    where: {
      tcsRatePct: SUPERSEDED_RATE,
      tcsAmount: { gt: 0 },
      OR: [{ status: "CANCELLED" }, { order: { is: { status: "CANCELLED" } } }],
    },
  });
  if (cancelled > 0) {
    console.log(
      `${cancelled} cancelled slice(s) left at ${SUPERSEDED_RATE}% on purpose - never remitted, never paid,` +
      " and correcting them would break scripts/repairLegacyAccrual.ts. See the note in this file.\n",
    );
  }

  if (rows.length === 0) { console.log("Nothing live at the superseded rate. Already corrected."); return; }

  // Refusals ---------------------------------------------------------------------------------
  const settled = rows.filter((r) => r.settled);
  if (settled.length > 0) {
    throw new Error(
      `${settled.length} affected slice(s) are already settled - the seller was PAID at 1%. ` +
      `That needs a clawback or a credit, not a column edit. Refusing.`,
    );
  }
  for (const period of new Set(rows.map((r) => periodOf(r.createdAt)))) {
    const filed = await filedAt(RETURN_TYPES.GSTR8, period);
    if (filed) {
      throw new Error(
        `GSTR-8 for ${period} was filed on ${filed.toISOString()} and contains affected rows. ` +
        `A filed return is corrected by amendment, not by rewriting its rows. Refusing.`,
      );
    }
  }

  // The correction, row by row ---------------------------------------------------------------
  const sellerIds = [...new Set(rows.map((r) => r.sellerId))];
  const before = new Map<string, { stored: number; derived: number }>();
  for (const sid of sellerIds) {
    const s = await prisma.seller.findUnique({ where: { id: sid }, select: { outstandingBalance: true } });
    before.set(sid, { stored: r2(n(s?.outstandingBalance)), derived: await derivedOwed(sid) });
  }

  const planned: { id: string; sellerId: string; oldTcs: number; newTcs: number; oldNet: number; newNet: number; counted: boolean }[] = [];
  console.log(`${rows.length} slice(s) at ${SUPERSEDED_RATE}%:\n`);
  for (const r of rows) {
    const taxable = r.taxableValue == null ? null : n(r.taxableValue);
    if (taxable == null) {
      throw new Error(`${r.order.orderNumber}: taxableValue is null but TCS was charged - cannot recompute. Refusing.`);
    }
    const oldTcs = n(r.tcsAmount);
    const newTcs = r2((taxable * TCS_RATE_PCT) / 100);
    const oldNet = n(r.netPayable);
    const newNet = r2(n(r.subtotal) - n(r.commissionAmount) - newTcs - n(r.tdsAmount));
    // Whether this slice is one the outstanding balance currently counts. The query above already
    // excludes cancelled slices and settled rows are refused outright, so this should always be
    // true - it is kept as an assertion rather than deleted, and prints if it ever is not.
    const counted = !r.settled && r.status !== "CANCELLED" && r.order.status !== "CANCELLED";
    planned.push({ id: r.id, sellerId: r.sellerId, oldTcs, newTcs, oldNet, newNet, counted });
    console.log(
      `  ${r.order.orderNumber}  ${r.seller.name.padEnd(20)} taxable=${taxable.toFixed(2).padStart(8)}` +
      `  tcs ${oldTcs.toFixed(2)} -> ${newTcs.toFixed(2)}   net ${oldNet.toFixed(2)} -> ${newNet.toFixed(2)}` +
      `${counted ? "" : "   (not in balance)"}`,
    );
  }

  const tcsReturned = r2(planned.reduce((t, p) => t + (p.oldTcs - p.newTcs), 0));
  const bySeller = new Map<string, number>();
  for (const p of planned) {
    if (!p.counted) continue;
    bySeller.set(p.sellerId, r2((bySeller.get(p.sellerId) ?? 0) + (p.newNet - p.oldNet)));
  }
  console.log(`\nTCS over-withheld, returned to sellers: ${tcsReturned.toFixed(2)}`);
  for (const [sid, delta] of bySeller) {
    const b = before.get(sid)!;
    const name = rows.find((r) => r.sellerId === sid)!.seller.name;
    console.log(`  ${name}: outstandingBalance ${b.stored.toFixed(2)} -> ${r2(b.stored + delta).toFixed(2)}  (+${delta.toFixed(2)})`);
  }

  if (!APPLY) { console.log("\nDry run - nothing written. Re-run with --apply."); return; }

  await prisma.$transaction(async (tx) => {
    for (const p of planned) {
      await tx.subOrder.update({
        where: { id: p.id },
        data: { tcsAmount: p.newTcs, tcsRatePct: TCS_RATE_PCT, netPayable: p.newNet },
        select: { id: true },
      });
    }
    for (const [sid, delta] of bySeller) {
      await tx.seller.update({ where: { id: sid }, data: { outstandingBalance: { increment: delta } }, select: { id: true } });
    }
  });

  // Verify by re-reading, not by trusting the writes ------------------------------------------
  console.log("\n--- after ---");
  const left = await prisma.subOrder.count({
    where: {
      tcsRatePct: SUPERSEDED_RATE,
      tcsAmount: { gt: 0 },
      status: { not: "CANCELLED" },
      order: { is: { status: { not: "CANCELLED" } } },
    },
  });
  console.log(`  live slices still at ${SUPERSEDED_RATE}%: ${left}${left === 0 ? "  - none" : "  WARNING"}`);
  for (const sid of sellerIds) {
    const s = await prisma.seller.findUnique({ where: { id: sid }, select: { name: true, outstandingBalance: true } });
    const b = before.get(sid)!;
    const stored = r2(n(s?.outstandingBalance));
    const derived = await derivedOwed(sid);
    const driftBefore = r2(b.stored - b.derived);
    const driftAfter = r2(stored - derived);
    console.log(
      `  ${s?.name}: stored ${b.stored.toFixed(2)} -> ${stored.toFixed(2)}, derived ${b.derived.toFixed(2)} -> ${derived.toFixed(2)}, ` +
      `drift ${driftBefore.toFixed(2)} -> ${driftAfter.toFixed(2)}  ` +
      `${Math.abs(driftAfter - driftBefore) < 0.005 ? "- unchanged, as intended" : "WARNING: THE FIX MOVED THE DRIFT"}`,
    );
  }
}

main().catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); }).finally(() => prisma.$disconnect());
