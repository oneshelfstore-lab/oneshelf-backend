/**
 * STEP 01 — read-only marketplace baseline. Performs NO writes of any kind.
 *
 * Answers the questions the migration runbook needs before any money math is touched:
 *   1. Is there real marketplace money yet, or is this genuinely pre-launch?
 *   2. Would switching commission/TDS onto taxableValue collapse any line to zero?
 *      (OrderItem.taxableValue is @default(0) — a legacy row would silently zero its commission.)
 *   3. Has any seller actually been paid, which turns every fix below into a restatement?
 *   4. Are payouts already happening on undelivered orders (the step-11 finding, live)?
 *
 * Raw SQL throughout, deliberately: this has to keep working when the generated Prisma client and
 * the DEPLOYED schema disagree — a migration written but not yet deployed makes any full-row query
 * fail with P2022, which is exactly how scripts/repairLegacyAccrual.ts silently rolled back once.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/step01Baseline.ts'
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const q = <T = any>(s: TemplateStringsArray, ...v: any[]) => prisma.$queryRaw<T[]>(s, ...v);

function head(title: string) {
  console.log(`\n${"─".repeat(70)}\n${title}\n${"─".repeat(70)}`);
}

async function main() {
  head("1. MARKETPLACE ACTIVITY — is there real money in the ledger yet?");
  const sub = await q`
    SELECT count(*)::int                                        AS suborders,
           count(*) FILTER (WHERE "tcsAmount" > 0)::int         AS with_tcs,
           count(*) FILTER (WHERE "tdsAmount" > 0)::int         AS with_tds,
           count(*) FILTER (WHERE settled)::int                 AS settled,
           coalesce(sum("commissionAmount"), 0)                 AS commission_total,
           coalesce(sum("tcsAmount"), 0)                        AS tcs_total,
           coalesce(sum("netPayable"), 0)                       AS net_total
    FROM "SubOrder"`;
  console.table(sub);

  head("2. ⚠️  THE BLOCKER CHECK — lines that would lose their commission at step 07");
  const zeroTaxable = await q`
    SELECT count(*)::int AS bad_rows,
           coalesce(sum("lineTotal"), 0) AS value_at_risk
    FROM "OrderItem"
    WHERE "lineTotal" > 0 AND "taxableValue" = 0`;
  console.table(zeroTaxable);
  const n = Number(zeroTaxable[0]?.bad_rows ?? 0);
  console.log(
    n === 0
      ? "   ✓ CLEAR — step 07 (commission/TDS onto taxable value) is safe to ship as planned."
      : `   ✗ BLOCKED — ${n} line(s) have lineTotal > 0 but taxableValue = 0.\n` +
        "     Backfill taxableValue for those rows BEFORE step 07, or their commission drops to nil.",
  );

  head("3. SELLERS — how many, and are any external?");
  console.table(await q`
    SELECT "isHouse", status, "gstin" IS NOT NULL AS has_gstin,
           count(*)::int AS sellers, coalesce(sum("outstandingBalance"), 0) AS owed
    FROM "Seller" GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2`);

  head("4. OUTSTANDING BALANCES — money the platform currently owes");
  const owed = await q`
    SELECT name, "isHouse", "commissionPct", "outstandingBalance"
    FROM "Seller" WHERE "outstandingBalance" <> 0 ORDER BY "outstandingBalance" DESC`;
  console.table(owed.length ? owed : [{ note: "none — nothing owed to any seller" }]);

  head("5. PAYOUTS — has real money already left?");
  const payouts = await q`
    SELECT count(*)::int AS payouts, coalesce(sum("netPaid"), 0) AS total_paid,
           coalesce(sum(commission), 0) AS commission_kept,
           coalesce(sum(tcs), 0) AS tcs_withheld, coalesce(sum(tds), 0) AS tds_withheld,
           min("paidAt") AS first, max("paidAt") AS last
    FROM "SellerPayout"`;
  console.table(payouts);
  console.log(
    Number(payouts[0]?.payouts ?? 0) === 0
      ? "   ✓ No payouts yet — every fix below is a CORRECTION, not a restatement."
      : "   ⚠ Payouts exist. Rate/base fixes become RESTATEMENTS of money already transferred.\n" +
        "     Re-read the runbook's step 01 'Watch' before continuing.",
  );

  head("6. STEP-11 FINDING, CHECKED LIVE — settled slices on undelivered orders");
  const early = await q`
    SELECT o."orderNumber", o.status AS order_status, s.status AS slice_status,
           s."netPayable", sel.name AS seller
    FROM "SubOrder" s
    JOIN "Order" o   ON o.id  = s."orderId"
    JOIN "Seller" sel ON sel.id = s."sellerId"
    WHERE s.settled = true AND o.status <> 'DELIVERED'
    ORDER BY o."orderNumber"`;
  console.table(early.length ? early : [{ note: "none — no seller was paid before delivery" }]);

  head("7. INVOICES — issued by whom?");
  console.table(await q`
    SELECT ("supplierName" IS NULL) AS platform_issued, "invoiceType",
           count(*)::int AS invoices, coalesce(sum("totalAmount"), 0) AS value
    FROM "Invoice" GROUP BY 1, 2 ORDER BY 1 DESC`);

  head("8. ORDER VOLUME — the scale we are actually operating at");
  console.table(await q`
    SELECT status, "paymentMethod", count(*)::int AS orders,
           coalesce(sum("totalAmount"), 0) AS value
    FROM "Order" GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15`);

  head("9. LIVE SCHEMA DRIFT — which pending migrations have reached the database?");
  console.table(await q`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_name = 'Seller' AND column_name = 'busyUntil')        AS seller_busyuntil,
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_name = 'OrderItem' AND column_name = 'commissionPct') AS orderitem_commissionpct,
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_name = 'Invoice' AND column_name = 'invoiceKind')     AS invoice_invoicekind`);
  console.log("   busyUntil=1 means the busy-mode migration has been deployed; 0 means it has not.");
  console.log("   The other two must be 0 — they are steps 04/05 and have not been written yet.");

  head("DONE — read-only. Nothing was written.");
}

main()
  .catch((e) => { console.error("\nFAILED:", e?.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
