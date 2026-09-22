/**
 * Read-only. Dumps EVERY scope-sensitive report, for every period that has invoices and every
 * scope that exists, as one canonical JSON blob — so the runbook step-13 neutrality gate is a
 * byte diff of two files rather than an eyeball of one report.
 *
 * WHY THIS AND NOT THE RUNBOOK'S CURL. The runbook says to diff
 * `/owner/reports/gstr1-json?period=2026-09` before and after. That proof is too small in three
 * ways and this script fixes all three:
 *
 *   1. `scopeFilter` feeds NINE reports, not one. GSTR-1 is the one that gets filed, but the sales
 *      register, GSTR-3B, the HSN summary, the daily till, receivables, P&L, presumptive turnover
 *      and the GST-health pre-filing check all resolve identity through the same predicate. A
 *      refactor that shifted an invoice between identities could leave GSTR-1 untouched and move
 *      the daily till.
 *   2. One period is one month. Invoices span several; a scope change could be neutral in
 *      September and not in August.
 *   3. The endpoint is Firebase-gated, so the curl needs a live owner token — which means the gate
 *      can only run AFTER deploying. This runs against live data from a laptop, so a break is
 *      caught before it ships rather than after.
 *
 * Run (both before and after the change, then diff):
 *   railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/reportScopeSnapshot.ts' > before.json
 */
import { PrismaClient } from "@prisma/client";
import {
  getSalesRegister,
  getGstr1Summary,
  getGstr3bSummary,
  getGstr1Json,
  getHsnSummary,
  getDailySummary,
  getOutstandingReceivables,
  getProfitAndLoss,
  getPresumptiveTurnover,
  getGstHealth,
  type InvoiceScope,
} from "../src/services/reports.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

/** Stable key order at every depth, so two runs of the same data are byte-identical. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]));
  }
  // Prisma Decimals serialise as objects; force them to a string so the shape can't drift.
  if (typeof v === "object" && v !== null) return String(v);
  return v;
}

async function main() {
  // ── The invoice population, as the census that the scopes partition. Part of the snapshot on
  //    purpose: if a refactor silently re-labels an invoice, this block moves even when the
  //    reports happen not to.
  const kinds = await prisma.invoice.groupBy({ by: ["invoiceKind"], _count: true });
  const bySupplier = await prisma.$queryRaw<{ platform_issued: boolean; n: bigint }[]>`
    SELECT ("supplierName" IS NULL) AS platform_issued, count(*) n FROM "Invoice" GROUP BY 1`;

  // The Sec 9(5) case: platform-issued (supplierName NULL) but NOT the store's own goods, because
  // the supplying seller is an external restaurant. These are the invoices for which "the platform
  // issued it" and "it is the shop's own supply" come apart — the exact pair the house predicate
  // currently conflates.
  const nineFive = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) n
    FROM "Invoice" i
    JOIN "SubOrder" so ON so.id = i."subOrderId"
    JOIN "Seller" s    ON s.id = so."sellerId"
    WHERE i."supplierName" IS NULL AND s."isHouse" = false`;

  const periods = await prisma.$queryRaw<{ p: string }[]>`
    SELECT DISTINCT to_char("invoiceDate", 'MMYYYY') p FROM "Invoice" ORDER BY 1`;
  const days = await prisma.$queryRaw<{ d: string }[]>`
    SELECT DISTINCT to_char("invoiceDate", 'YYYY-MM-DD') d FROM "Invoice" ORDER BY 1`;
  const sellers = await prisma.seller.findMany({
    select: { id: true, name: true, isHouse: true }, orderBy: { id: "asc" },
  });
  const fyYears = await prisma.$queryRaw<{ y: number }[]>`
    SELECT DISTINCT (EXTRACT(YEAR FROM "invoiceDate") - CASE WHEN EXTRACT(MONTH FROM "invoiceDate") < 4 THEN 1 ELSE 0 END)::int y
    FROM "Invoice" ORDER BY 1`;

  const scopes: [string, InvoiceScope][] = [
    ["house", { kind: "house" }],
    ["all", { kind: "all" }],
    ...sellers.map((s) => [`seller:${s.id}`, { kind: "seller", sellerId: s.id }] as [string, InvoiceScope]),
  ];

  const out: Record<string, unknown> = {
    census: {
      byInvoiceKind: kinds.map((k) => ({ kind: k.invoiceKind, n: k._count })),
      bySupplierSnapshot: bySupplier.map((r) => ({ platformIssued: r.platform_issued, n: Number(r.n) })),
      sec9_5PlatformIssuedButNotHouse: Number(nineFive[0]?.n ?? 0),
      periods: periods.map((r) => r.p),
      sellers,
    },
    reports: {},
  };

  const reports = out.reports as Record<string, unknown>;

  // Full history, so no month can hide a shift.
  const allFrom = new Date("2000-01-01");
  const allTo = new Date("2099-12-31T23:59:59.999Z");

  for (const [label, scope] of scopes) {
    const r: Record<string, unknown> = {};
    r.salesRegister = await getSalesRegister(allFrom, allTo, scope);
    r.hsnSummary = await getHsnSummary(allFrom, allTo, scope);
    for (const { p } of periods) {
      r[`gstr1Summary:${p}`] = await getGstr1Summary(p, scope);
      r[`gstr3b:${p}`] = await getGstr3bSummary(p, scope);
      r[`gstr1Json:${p}`] = await getGstr1Json(p, scope);
    }
    for (const { d } of days) r[`dailySummary:${d}`] = await getDailySummary(d, scope);
    reports[label] = r;
  }

  // Hardcoded-house reports: no scope argument, but they resolve identity through the SAME
  // predicate, so they belong in the gate.
  reports["houseOnly:receivables"] = await getOutstandingReceivables();
  reports["houseOnly:profitAndLoss"] = await getProfitAndLoss(allFrom, allTo);
  for (const { y } of fyYears) reports[`houseOnly:presumptive:${y}`] = await getPresumptiveTurnover(y);
  for (const { p } of periods) reports[`houseOnly:gstHealth:${p}`] = await getGstHealth(p);

  console.log(JSON.stringify(canonical(out), null, 2));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
