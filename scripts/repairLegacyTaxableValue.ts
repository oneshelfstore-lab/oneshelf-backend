/**
 * One-off repair for the one OrderItem that grosses real money against a taxable value of zero
 * (runbook step 07's "Before" gate, and step 01's query 2).
 *
 * ONE LIVE ROW, on ONS/2627/00028. It predates OrderItem.taxableValue, which was added with
 * DEFAULT 0 — so its zero is "never computed", not "genuinely zero-rated". The two are
 * indistinguishable in the data, which is exactly why every column added after it was made nullable
 * instead (see prisma/migrations/20260921000000_marketplace_money_columns).
 *
 * ⚠️ WHY IT MUST BE FIXED BEFORE STEP 07 AND NOT AFTER. Step 07 moves commission off the
 * GST-inclusive lineTotal and onto taxableValue. With the column reading 0, this line's commission
 * silently collapses to nil — the seller is under-charged and nothing on any screen says so.
 *
 * ⚠️ THE VALUE IS DERIVED, NOT ASSUMED. taxableValue = lineTotal − cgst − sgst. For a line carrying
 * no tax that is the gross itself: a zero-rated supply has a taxable value EQUAL to its gross, never
 * zero. The script REFUSES if the line's own tax components do not support the figure it is about to
 * write, so it cannot quietly launder a guess into the commission base.
 *
 * It also fills the parent SubOrder.taxableValue, which the step-04 backfill deliberately left NULL
 * on exactly this slice rather than writing a 0 it could not stand behind.
 *
 * Dry run:  railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/repairLegacyTaxableValue.ts'
 * Apply:    ... same, with --apply
 *
 * Idempotent: it only selects lines still reading 0 against a positive gross.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const APPLY = process.argv.includes("--apply");
const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);

async function main() {
  console.log(APPLY ? "MODE: APPLY (will write)" : "MODE: DRY RUN (no writes)");

  const rows = await prisma.orderItem.findMany({
    where: { lineTotal: { gt: 0 }, taxableValue: 0 },
    select: {
      id: true, productName: true, lineTotal: true, taxableValue: true,
      cgst: true, sgst: true, gstRate: true, subOrderId: true,
      order: { select: { orderNumber: true, status: true } },
    },
  });

  if (rows.length === 0) { console.log("No line grosses money against a zero taxable value. Already clean."); return; }
  console.log(`\n${rows.length} line(s):\n`);

  const planned: { id: string; subOrderId: string | null; taxable: number }[] = [];
  for (const r of rows) {
    const gross = n(r.lineTotal);
    const tax = r2(n(r.cgst) + n(r.sgst));
    const taxable = r2(gross - tax);
    console.log(
      `  ${r.order.orderNumber} [${r.order.status}]  ${r.productName}` +
      `\n    lineTotal ${gross.toFixed(2)}  cgst ${n(r.cgst).toFixed(2)}  sgst ${n(r.sgst).toFixed(2)}` +
      `  gstRate ${n(r.gstRate)}%  ->  taxableValue ${taxable.toFixed(2)}`,
    );

    // ⚠️ The refusal. A line carrying real tax cannot have its taxable value inferred this way
    // without agreeing with its own rate, and a mismatch means the row is telling two stories.
    const impliedTax = n(r.gstRate) > 0 ? r2((taxable * n(r.gstRate)) / 100) : 0;
    if (Math.abs(impliedTax - tax) > 0.01) {
      throw new Error(
        `${r.order.orderNumber}: gstRate ${n(r.gstRate)}% on a taxable value of ${taxable.toFixed(2)} implies ` +
        `${impliedTax.toFixed(2)} of tax, but the line stores ${tax.toFixed(2)}. The row disagrees with itself - refusing.`,
      );
    }
    planned.push({ id: r.id, subOrderId: r.subOrderId, taxable });
  }

  // The parent slices the step-04 backfill skipped for exactly this reason.
  const sliceIds = [...new Set(planned.map((p) => p.subOrderId).filter((x): x is string => !!x))];
  const slices = await prisma.subOrder.findMany({
    where: { id: { in: sliceIds } },
    select: { id: true, taxableValue: true, subtotal: true, seller: { select: { name: true, isHouse: true } } },
  });
  console.log();
  for (const s of slices) {
    console.log(
      `  slice ${s.seller.name}${s.seller.isHouse ? " [house]" : ""}: subtotal ${n(s.subtotal).toFixed(2)},` +
      ` taxableValue ${s.taxableValue == null ? "null" : n(s.taxableValue).toFixed(2)} -> will be re-summed from its items`,
    );
  }

  if (!APPLY) { console.log("\nDry run - nothing written. Re-run with --apply."); return; }

  await prisma.$transaction(async (tx) => {
    for (const p of planned) {
      await tx.orderItem.update({ where: { id: p.id }, data: { taxableValue: p.taxable }, select: { id: true } });
    }
    for (const sid of sliceIds) {
      const agg = await tx.orderItem.aggregate({ where: { subOrderId: sid }, _sum: { taxableValue: true } });
      await tx.subOrder.update({
        where: { id: sid },
        data: { taxableValue: r2(n(agg._sum.taxableValue)) },
        select: { id: true },
      });
    }
  });

  // Re-read rather than trust the writes.
  console.log("\n--- after ---");
  const left = await prisma.orderItem.count({ where: { lineTotal: { gt: 0 }, taxableValue: 0 } });
  console.log(`  lines grossing money against a zero taxable value: ${left}${left === 0 ? "  - none" : "  WARNING"}`);
  for (const sid of sliceIds) {
    const s = await prisma.subOrder.findUnique({
      where: { id: sid },
      select: { taxableValue: true, subtotal: true, seller: { select: { name: true } } },
    });
    console.log(`  slice ${s?.seller.name}: subtotal ${n(s?.subtotal).toFixed(2)}, taxableValue ${n(s?.taxableValue).toFixed(2)}`);
  }
  const stillNull = await prisma.subOrder.count({ where: { taxableValue: null } });
  console.log(`  sub-orders still carrying a null taxableValue: ${stillNull}`);
}

main().catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); }).finally(() => prisma.$disconnect());
