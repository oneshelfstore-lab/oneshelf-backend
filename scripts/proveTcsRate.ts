/**
 * Runbook step 06's prove, run against live data. Performs NO writes.
 *
 * Its words: "A test order with ₹200 taxable from an external seller produces tcsAmount = 1.00, not
 * 2.00. Open the GSTR-8 report for the current month and check the CGST and SGST halves are 0.25%
 * each." The first half is a unit test (services/__tests__/sellerSplit.test.ts); this is the second.
 *
 * ⚠️ IT ALSO PROVES THE TRAP THAT WAS AVOIDED, which is the more interesting half. Both reports used
 * to recover a period's liable value as tcsAmount ÷ the CURRENT rate constant. That arithmetic
 * silently assumes every row was written at today's rate, so halving the constant would have DOUBLED
 * the liable value of every row written before it — in a return that goes to the government. Each
 * period below prints what the old method would now say beside what the stored base actually says.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/proveTcsRate.ts'
 */
import { PrismaClient } from "@prisma/client";
import { TCS_RATE_PCT } from "../src/data/taxRates.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);

async function main() {
  console.log(`TCS_RATE_PCT = ${TCS_RATE_PCT}  (0.25% CGST + 0.25% SGST on an intra-state supply)\n`);

  // Exactly what routes/ownerGstr8.ts now groups by — seller and the rate the row was written at.
  const rows = await prisma.subOrder.groupBy({
    by: ["sellerId", "tcsRatePct"],
    where: { tcsAmount: { gt: 0 }, order: { is: { status: { not: "CANCELLED" } } } },
    _sum: { tcsAmount: true, taxableValue: true, subtotal: true },
    _count: true,
  });
  if (rows.length === 0) { console.log("No live TCS rows."); return; }

  const sellers = await prisma.seller.findMany({
    where: { id: { in: rows.map((r) => r.sellerId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(sellers.map((s) => [s.id, s.name]));

  console.log("seller                 rate   rows      TCS   liable (stored)   CGST   SGST   each as % of liable");
  for (const r of rows) {
    const tcs = r2(n(r._sum.tcsAmount));
    const liable = r2(n(r._sum.taxableValue));
    const half = r2(tcs / 2);
    const pct = liable > 0 ? r2((half / liable) * 100) : 0;
    console.log(
      `  ${(nameById.get(r.sellerId) ?? "?").padEnd(20)} ${String(n(r.tcsRatePct)).padStart(4)}%` +
      ` ${String(r._count).padStart(5)} ${tcs.toFixed(2).padStart(9)} ${liable.toFixed(2).padStart(17)}` +
      ` ${half.toFixed(2).padStart(6)} ${half.toFixed(2).padStart(6)}   ${pct}%` +
      `${pct === n(r.tcsRatePct) / 2 ? "" : "   MISMATCH"}`,
    );
  }

  // The trap, stated in rupees.
  const totalTcs = r2(rows.reduce((t, r) => t + n(r._sum.tcsAmount), 0));
  const storedLiable = r2(rows.reduce((t, r) => t + n(r._sum.taxableValue), 0));
  const oldMethod = r2(totalTcs / (TCS_RATE_PCT / 100));
  console.log(
    `\nliable value, read from the stored base:            ${storedLiable.toFixed(2)}` +
    `\nliable value, old method (TCS / today's constant):   ${oldMethod.toFixed(2)}` +
    `  ${oldMethod === storedLiable ? "- same, because every live row is now at today's rate" : `- OVERSTATED BY ${r2(oldMethod - storedLiable).toFixed(2)}`}`,
  );

  // Cancelled rows still carry the old rate on purpose (see scripts/repairTcsRate.ts). They are
  // excluded from the return, but they are what a mixed-rate period looks like — so read them back
  // through the same grouping to show the per-row rate is genuinely being used, not assumed.
  const stale = await prisma.subOrder.groupBy({
    by: ["tcsRatePct"],
    where: { tcsAmount: { gt: 0 } },
    _sum: { tcsAmount: true, taxableValue: true },
    _count: true,
  });
  console.log("\nevery TCS-bearing row, by the rate it was written at (cancelled included):");
  for (const g of stale) {
    const tcs = r2(n(g._sum.tcsAmount));
    const liable = r2(n(g._sum.taxableValue));
    const derived = liable > 0 ? r2((tcs / liable) * 100) : 0;
    console.log(
      `  ${String(n(g.tcsRatePct)).padStart(4)}%  rows=${String(g._count).padStart(3)}  tcs=${tcs.toFixed(2).padStart(6)}` +
      `  liable=${liable.toFixed(2).padStart(9)}  tcs/liable=${derived}%` +
      `  ${derived === n(g.tcsRatePct) ? "- the stored rate is the rate that was applied" : "  MISMATCH"}`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
