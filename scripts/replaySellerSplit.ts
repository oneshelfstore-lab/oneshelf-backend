/**
 * STEP 02 PROOF — replay every SubOrder ever written through the extracted pure function and
 * compare, field by field, against what is actually stored. Performs NO writes.
 *
 * The runbook asks for "a placed test order produces identical SubOrder values to before". This is
 * the stronger version of that check: instead of one new order, it re-derives all 391 orders' worth
 * of slices from their own order items and fails if a single paise of commission, TCS or net payable
 * comes out different. If the extraction drifted anywhere, this finds it.
 *
 * The inputs are taken from the row's OWN snapshot (commissionPct, tdsAmount) rather than from the
 * seller's current record, because a seller's rate can have changed since the order was placed —
 * comparing against today's rate would report a false mismatch on a row that was correct when it
 * was written.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/replaySellerSplit.ts'
 */
import { PrismaClient } from "@prisma/client";
import { sumSellerLines, computeSellerSplit } from "../src/services/sellerSplit.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

/** The rate each path used at placement. Food is 0 under Sec 9(5); goods are still on the old 1%. */
const TCS_RATE_GOODS = 1;
const TCS_RATE_FOOD = 0;

type Row = {
  id: string;
  orderNumber: string;
  sellerName: string;
  vertical: string;
  isHouse: boolean;
  subtotal: string;
  commissionPct: string;
  commissionAmount: string;
  tcsAmount: string;
  tdsAmount: string;
  netPayable: string;
  itemsGross: string;
  itemsTaxable: string;
  nItems: number;
};

async function main() {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT s.id,
           o."orderNumber"        AS "orderNumber",
           sel.name               AS "sellerName",
           sel.vertical,
           sel."isHouse",
           s.subtotal, s."commissionPct", s."commissionAmount",
           s."tcsAmount", s."tdsAmount", s."netPayable",
           (SELECT coalesce(sum(i."lineTotal"), 0)     FROM "OrderItem" i WHERE i."subOrderId" = s.id) AS "itemsGross",
           (SELECT coalesce(sum(i."taxableValue"), 0)  FROM "OrderItem" i WHERE i."subOrderId" = s.id) AS "itemsTaxable",
           (SELECT count(*)::int                       FROM "OrderItem" i WHERE i."subOrderId" = s.id) AS "nItems"
    FROM "SubOrder" s
    JOIN "Order"  o   ON o.id  = s."orderId"
    JOIN "Seller" sel ON sel.id = s."sellerId"
    ORDER BY o."orderNumber"`;

  console.log(`Replaying ${rows.length} sub-orders through computeSellerSplit…\n`);

  const mismatches: string[] = [];
  let orphaned = 0;
  let checked = 0;

  for (const r of rows) {
    // A slice whose items were never linked back (subOrderId null) has nothing to re-derive from.
    if (r.nItems === 0) {
      orphaned++;
      continue;
    }
    checked++;

    const isFood = r.vertical === "FOOD";
    const stored = {
      subtotal: Number(r.subtotal),
      commissionAmount: Number(r.commissionAmount),
      tcsAmount: Number(r.tcsAmount),
      netPayable: Number(r.netPayable),
    };

    // Re-derive the sums from the order items, exactly as placement does.
    const summed = sumSellerLines([
      { lineTotal: Number(r.itemsGross), taxableValue: Number(r.itemsTaxable) },
    ]);

    const split = computeSellerSplit({
      // Food takes its subtotal from the priced totals, not from a line sum, so trust the stored
      // figure there. Goods sum their lines — which is what `summed.subtotal` is checking.
      subtotal: isFood ? stored.subtotal : summed.subtotal,
      taxableValue: summed.taxableValue,
      commissionPct: Number(r.commissionPct),
      tcsRatePct: isFood ? TCS_RATE_FOOD : TCS_RATE_GOODS,
      tdsAmount: Number(r.tdsAmount),
      isHouse: r.isHouse,
    });

    const bad: string[] = [];
    if (!isFood && summed.subtotal !== stored.subtotal) {
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
      mismatches.push(`  ${r.orderNumber} / ${r.sellerName} [${r.vertical}] — ${bad.join(" · ")}`);
    }
  }

  console.log(`  checked:  ${checked}`);
  console.log(`  skipped:  ${orphaned} (no order items linked to the slice — nothing to re-derive)`);
  console.log(`  mismatch: ${mismatches.length}\n`);

  if (mismatches.length) {
    console.log("MISMATCHES — the extraction is NOT byte-identical:");
    mismatches.slice(0, 40).forEach((m) => console.log(m));
    if (mismatches.length > 40) console.log(`  …and ${mismatches.length - 40} more`);
    process.exitCode = 1;
  } else {
    console.log("✓ Every re-derived slice matches its stored row to the paise.");
  }
}

main()
  .catch((e) => {
    console.error("\nFAILED:", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
