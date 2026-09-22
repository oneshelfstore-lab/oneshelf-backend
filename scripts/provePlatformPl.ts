/**
 * Runbook step 21's prove, against live data. Read-only — this script writes nothing.
 *
 * Its words: "Payable-to-sellers on the balance sheet equals the sum of Seller.outstandingBalance.
 * If it does not, the ledger and the report disagree and one of them is wrong."
 *
 * ⚠️ A REPORT THAT SIMPLY PRINTS THAT COLUMN CANNOT FAIL THAT TEST, because it is quoting the thing
 * it is meant to be checked against. So the balance sheet derives the figure a SECOND way — from the
 * unsettled slices and adjustments the ledger is supposed to be a summary of — and this prints both.
 * They were ₹186.12 apart until the legacy unreversed accrual was repaired earlier today.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/provePlatformPl.ts'
 */
import { PrismaClient } from "@prisma/client";
import { buildPlatformPl, buildPlatformBalanceSheet } from "../src/services/platformPl.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);
const rs = (v: number) => v.toFixed(2).padStart(12);

async function main() {
  const bs = await buildPlatformBalanceSheet();

  console.log("OWED TO SELLERS");
  console.log("  seller                     stored      derived");
  for (const s of bs.owedToSellers.bySeller) {
    const gap = r2(s.stored - s.derived);
    console.log(`  ${s.name.padEnd(24)}${rs(s.stored)} ${rs(s.derived)}${Math.abs(gap) > 0.005 ? `   drift ${gap.toFixed(2)}` : ""}`);
  }
  console.log(`  ${"TOTAL".padEnd(24)}${rs(bs.owedToSellers.stored)} ${rs(bs.owedToSellers.derived)}`);
  console.log(
    `\n  Σ Seller.outstandingBalance = ${bs.owedToSellers.stored.toFixed(2)}` +
    `\n  re-derived from the slices  = ${bs.owedToSellers.derived.toFixed(2)}` +
    `\n  drift ${bs.owedToSellers.drift.toFixed(2)}  ` +
    (bs.owedToSellers.reconciles
      ? "- the ledger and the orders behind it agree"
      : "- THEY DISAGREE, and one of them is wrong"),
  );

  // The independent third opinion. If this and the balance sheet ever differ, the service is
  // filtering something the ledger is not.
  const raw = await prisma.seller.aggregate({ where: { isHouse: false }, _sum: { outstandingBalance: true } });
  const rawSum = r2(n(raw._sum.outstandingBalance));
  console.log(
    `  read straight off the column again: ${rawSum.toFixed(2)}` +
    `  ${rawSum === bs.owedToSellers.stored ? "- same" : "  THE REPORT IS FILTERING SOMETHING"}`,
  );

  console.log(`\nALSO HELD`);
  console.log(`  customer store credit     ${rs(bs.customerStoreCredit)}`);
  console.log(`  tax accrued, not yet filed${rs(bs.taxNotYetFiled.total)}` +
    `   (tcs ${bs.taxNotYetFiled.tcs.toFixed(2)} · commission GST ${bs.taxNotYetFiled.commissionGst.toFixed(2)}` +
    ` · delivery GST ${bs.taxNotYetFiled.deliveryGst.toFixed(2)} · tds ${bs.taxNotYetFiled.tds.toFixed(2)})`);
  console.log(`  TOTAL OBLIGATIONS         ${rs(bs.totalObligations)}`);
  console.log(
    `\n  ⚠️ Obligations, not a cash position. No bank balance exists anywhere in this system, so what` +
    `\n     the platform HAS cannot be stated — only what it owes.`,
  );

  // ── P&L over everything, so the numbers are not an empty month ─────────────────────────────
  const first = await prisma.order.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  const from = first?.createdAt ?? new Date(0);
  const to = new Date();
  const pl = await buildPlatformPl(from, to);

  console.log(`\nPLATFORM P&L  ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}  (${pl.orderCount} orders)`);
  console.log(`  commission earned         ${rs(pl.income.commission)}`);
  console.log(`  delivery, net of GST      ${rs(pl.income.deliveryNet)}`);
  console.log(`  INCOME                    ${rs(pl.income.total)}`);
  console.log(`  coupons funded            ${rs(-pl.cost.coupons)}`);
  console.log(`  member discount           ${rs(-pl.cost.loyalty)}`);
  console.log(`  delivery waived by tier   ${rs(-pl.cost.deliveryWaived)}`);
  console.log(`  COST                      ${rs(-pl.cost.total)}`);
  console.log(`  MARGIN                    ${rs(pl.margin)}`);
  console.log(`\n  held for the government   ${rs(pl.heldForGovernment.total)}` +
    `   (commission GST ${pl.heldForGovernment.commissionGst.toFixed(2)} · delivery GST ${pl.heldForGovernment.deliveryGst.toFixed(2)}` +
    ` · tcs ${pl.heldForGovernment.tcs.toFixed(2)} · tds ${pl.heldForGovernment.tds.toFixed(2)})`);

  if (pl.income.deliveryUnsplitOrderCount > 0) {
    console.log(
      `\n  ⚠️ ${pl.income.deliveryUnsplitOrderCount} order(s) carry ₹${pl.income.deliveryUnsplit.toFixed(2)} of delivery fee with NO` +
      `\n     tax split — they predate step 15. It is EXCLUDED from income above rather than counted` +
      `\n     gross, which would overstate the platform's earnings by the GST inside it.`,
    );
  }

  // Cross-check the two income lines against their own columns, independently of the service.
  const c = await prisma.subOrder.aggregate({
    where: { status: { not: "CANCELLED" }, order: { is: { status: { not: "CANCELLED" }, createdAt: { gte: from, lte: to } } } },
    _sum: { commissionAmount: true },
  });
  const d = await prisma.order.aggregate({
    where: { status: { not: "CANCELLED" }, createdAt: { gte: from, lte: to } },
    _sum: { deliveryTaxable: true },
  });
  console.log(
    `\nCROSS-CHECK` +
    `\n  commission: report ${pl.income.commission.toFixed(2)} vs column ${r2(n(c._sum.commissionAmount)).toFixed(2)}` +
    `  ${pl.income.commission === r2(n(c._sum.commissionAmount)) ? "- same" : "  MISMATCH"}` +
    `\n  delivery:   report ${pl.income.deliveryNet.toFixed(2)} vs column ${r2(n(d._sum.deliveryTaxable)).toFixed(2)}` +
    `  ${pl.income.deliveryNet === r2(n(d._sum.deliveryTaxable)) ? "- same" : "  MISMATCH"}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
