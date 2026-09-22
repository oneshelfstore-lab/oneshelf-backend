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
 * ⚠️ RUN THIS ONCE PER STAGE, NOT ONCE PER STEP. It is the gate for a change that alters how
 * EXISTING rows are read — step 13's scope rewrite is the whole reason it exists. A step that only
 * changes how NEW rows are written (14, 15, 16) cannot move a report over data already in the
 * database, so re-running it there re-proves something already proven. Keep the HEAD snapshot
 * between steps too: HEAD does not change while a stage is in flight.
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

/**
 * Fields whose value is derived from the wall clock rather than from the data.
 *
 * ⚠️ These MUST be redacted or the gate is flaky by construction. `ageDays` on a receivable is
 * `floor((now - invoiceDate) / 1 day)`, so it ticks at each invoice's own time of day — two runs
 * fifteen minutes apart can legitimately differ, and a reviewer then has to decide by hand whether
 * a one-line diff is a clock or a bug. Redacting makes an empty diff mean what it should: nothing
 * about the DATA moved.
 *
 * ⚠️ Deliberately narrow. Only the duration is redacted, never an amount, an invoice number or the
 * set of rows returned. Bucket membership (current / 30 / 60 / 90) is also age-derived and is left
 * alone — it only moves at a 30-day boundary, which is rare enough to notice and read.
 */
const WALL_CLOCK_FIELDS = new Set(["ageDays"]);

/** Stable key order at every depth, so two runs of the same data are byte-identical. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o).sort().map((k) => [k, WALL_CLOCK_FIELDS.has(k) ? "<wall-clock>" : canonical(o[k])]),
    );
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
  // ⚠️ SAMPLED, not swept, and the reason it is sound is worth stating: the daily till resolves
  // identity through the same `scopeFilter(scope)` fragment as every other report here, spread into
  // a where clause alongside a date range. The DATE is a filter, not a branch — there is no
  // per-day logic for a scope bug to hide behind. So calling it on three representative days
  // exercises exactly the same predicate as calling it on all of them.
  //
  // The sweep cost 9 scopes x every invoice day = 351 of the 484 report calls this script makes,
  // 73% of its runtime, to re-test one code path 39 times. First day, last day, and the busiest day
  // (the one most likely to span several scopes at once) is the same coverage for a twentieth of
  // the round trips.
  const allDays = await prisma.$queryRaw<{ d: string; n: bigint }[]>`
    SELECT to_char("invoiceDate", 'YYYY-MM-DD') d, count(*) n
    FROM "Invoice" GROUP BY 1 ORDER BY 1`;
  const busiest = [...allDays].sort((a, b) => Number(b.n) - Number(a.n))[0];
  const days = [...new Map(
    [allDays[0], allDays[allDays.length - 1], busiest]
      .filter((x): x is { d: string; n: bigint } => !!x)
      .map((x) => [x.d, { d: x.d }]),
  ).values()].sort((a, b) => a.d.localeCompare(b.d));
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
      // In the snapshot on purpose: if a future edit quietly drops a day or a period from the
      // sample, the diff says so instead of the gate getting weaker without anyone noticing.
      dailySummaryDaysSampled: days.map((x) => x.d),
      invoiceDaysTotal: allDays.length,
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
