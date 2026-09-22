/**
 * Replay every SubOrder ever written through the pure split and compare, field by field, against
 * what is actually stored. Performs NO writes.
 *
 * Written for runbook step 02 ("a placed test order produces identical SubOrder values to before")
 * as the stronger version of that check: instead of one new order, it re-derives every live slice
 * from its own order items and fails if a single paise of commission, TCS or net payable comes out
 * different.
 *
 * ⚠️ IT REPLAYS THE REAL LINES, one at a time, and that is what makes it step 08's prove too.
 * Commission is now resolved per line and the rounded line amounts are summed, where it used to be
 * one rate times one subtotal. Those two can differ by a paise on some inputs. Collapsing the slice
 * into a single synthetic line — which this script used to do — would hide exactly that difference.
 *
 * ⚠️ The rates come from the row's OWN snapshot (commissionPct, tcsRatePct, tdsAmount), never from
 * the seller's current record or from today's constant. A seller's rate can have changed since the
 * order was placed, and the statutory TCS rate has; comparing against today's numbers would report
 * a false mismatch on a row that was perfectly correct when it was written. It is also why this
 * check stays green across scripts/repairTcsRate.ts — it reads whatever rate each row now carries.
 *
 * ⚠️ AND SO DOES THE RULE, not just the rate. Runbook step 07 moved commission off the GST-inclusive
 * lineTotal onto taxableValue and began withholding the GST on it. `SubOrder.commissionGstAmount`
 * is the marker for which side of that a row sits on: NULL means it was written before, so it is
 * replayed on the old base with no GST withheld. Without that branch this script would report every
 * historical row as a mismatch and stop being a regression net at exactly the moment one is useful.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/replaySellerSplit.ts'
 */
import { PrismaClient } from "@prisma/client";
import { sumSellerLines, computeSellerSplit } from "../src/services/sellerSplit.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

/** The split's own rounding. Not round2 — see services/sellerSplit.ts. */
const r2 = (v: number) => +v.toFixed(2);

async function main() {
  const slices = await prisma.subOrder.findMany({
    select: {
      id: true,
      subtotal: true,
      commissionPct: true,
      commissionAmount: true,
      commissionGstAmount: true,
      tcsAmount: true,
      tcsRatePct: true,
      tdsAmount: true,
      netPayable: true,
      order: { select: { orderNumber: true } },
      seller: { select: { name: true, vertical: true, isHouse: true } },
      items: {
        select: {
          lineTotal: true,
          taxableValue: true,
          variant: { select: { product: { select: { commissionPctOverride: true } } } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Replaying ${slices.length} sub-orders through sumSellerLines + computeSellerSplit...\n`);

  const mismatches: string[] = [];
  let orphaned = 0;
  let checked = 0;
  let multiLine = 0;
  let legacyRule = 0;

  for (const s of slices) {
    // A slice whose items were never linked back (subOrderId null) has nothing to re-derive from.
    if (s.items.length === 0) { orphaned++; continue; }
    checked++;
    if (s.items.length > 1) multiLine++;
    if (s.commissionGstAmount == null) legacyRule++;

    const isFood = s.seller.vertical === "FOOD";
    const stored = {
      subtotal: Number(s.subtotal),
      commissionAmount: Number(s.commissionAmount),
      tcsAmount: Number(s.tcsAmount),
      netPayable: Number(s.netPayable),
    };

    const lines = s.items.map((i) => ({
      lineTotal: Number(i.lineTotal),
      taxableValue: Number(i.taxableValue),
      commissionPctOverride:
        i.variant?.product.commissionPctOverride == null
          ? null
          : Number(i.variant.product.commissionPctOverride),
    }));

    // Food takes its subtotal from its own priced totals, not from a line sum, so its slice is
    // replayed as one line at the stored subtotal — exactly as routes/foodOrders.ts does it.
    const summed = isFood
      ? sumSellerLines(
          [{ lineTotal: stored.subtotal, taxableValue: Number(s.items.reduce((t, i) => t + Number(i.taxableValue), 0).toFixed(2)) }],
          Number(s.commissionPct),
        )
      : sumSellerLines(lines, Number(s.commissionPct));

    // Which rule was in force when this row was written. A pre-step-07 row charged commission on the
    // GST-inclusive line total and withheld no GST on it; the arithmetic for that era lives HERE, in
    // the replay, rather than as a dead branch inside the production function.
    const preStep07 = s.commissionGstAmount == null;
    const legacyCommission = r2(
      (isFood ? [{ lineTotal: stored.subtotal, commissionPctOverride: null as number | null }] : lines).reduce(
        (sum, l) => sum + r2((Number(l.lineTotal) * Number(s.commissionPct)) / 100),
        0,
      ),
    );

    const split = computeSellerSplit({
      subtotal: summed.subtotal,
      taxableValue: summed.taxableValue,
      commissionPct: summed.commissionPct,
      commissionAmount: preStep07 ? legacyCommission : summed.commissionAmount,
      commissionGstAmount: preStep07 ? 0 : Number(s.commissionGstAmount),
      // The rate this row was actually written at. Null only on a row that predates the snapshot
      // column, and the step-04 migration backfilled every one of those.
      tcsRatePct: Number(s.tcsRatePct ?? 0),
      tdsAmount: Number(s.tdsAmount),
      isHouse: s.seller.isHouse,
    });

    const bad: string[] = [];
    if (summed.subtotal !== stored.subtotal) {
      bad.push(`subtotal stored=${stored.subtotal} re-summed=${summed.subtotal}`);
    }
    if (split.commissionAmount !== stored.commissionAmount) {
      bad.push(`commission stored=${stored.commissionAmount} computed=${split.commissionAmount}`);
    }
    if (split.tcsAmount !== stored.tcsAmount) {
      bad.push(`tcs stored=${stored.tcsAmount} computed=${split.tcsAmount}`);
    }
    if (split.netPayable !== stored.netPayable) {
      bad.push(`netPayable stored=${stored.netPayable} computed=${split.netPayable}`);
    }
    if (bad.length) {
      mismatches.push(`  ${s.order.orderNumber} / ${s.seller.name} [${s.seller.vertical}] - ${bad.join(" | ")}`);
    }
  }

  console.log(`  checked:     ${checked}  (${multiLine} of them multi-line, where per-line rounding can bite)`);
  console.log(`  pre-step-07: ${legacyRule}  (commission on the gross, no GST withheld - replayed under that rule)`);
  console.log(`  skipped:     ${orphaned} (no order items linked to the slice - nothing to re-derive)`);
  console.log(`  mismatch:    ${mismatches.length}\n`);

  if (mismatches.length) {
    console.log("MISMATCHES - the replay does NOT reproduce what is stored:");
    mismatches.slice(0, 40).forEach((m) => console.log(m));
    if (mismatches.length > 40) console.log(`  ...and ${mismatches.length - 40} more`);
    process.exitCode = 1;
  } else {
    console.log("OK - every re-derived slice matches its stored row to the paise.");
  }
}

main()
  .catch((e) => {
    console.error("\nFAILED:", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
