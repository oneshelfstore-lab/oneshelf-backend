/**
 * READ-ONLY ledger audit. Performs no writes of any kind.
 *
 * Answers three questions:
 *   1. Does each seller's denormalized Seller.outstandingBalance match what the SubOrder rows imply?
 *   2. Is there a fingerprint of the P1 double-payout (a SellerPayout that paid money but ended up
 *      owning no SubOrders, because a racing payout re-claimed them and overwrote payoutId)?
 *   3. Are there duplicate open cash-handover declarations (the P2 race)?
 *
 * Run: railway run --service Postgres npx tsx scripts/auditLedger.ts
 */
import { PrismaClient } from "@prisma/client";

// `railway run` on the backend service injects the internal host, which isn't reachable from a
// laptop; the Postgres service exposes DATABASE_PUBLIC_URL. Prefer it when present.
const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url } } });

const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => Math.round(v * 100) / 100;

async function main() {
  // ── 1. outstandingBalance drift ───────────────────────────────────────────────
  const sellers = await prisma.seller.findMany({
    select: { id: true, name: true, isHouse: true, isActive: true, status: true, outstandingBalance: true },
    orderBy: { name: "asc" },
  });

  console.log(`\n=== 1. Seller.outstandingBalance vs derived (${sellers.length} sellers) ===`);
  let drifted = 0;
  for (const s of sellers) {
    // ⚠️ The HOUSE store is skipped, and that is not laziness. It is deliberately never accrued
    // (routes/orders.ts only increments outstandingBalance `if (!seller.isHouse)` — the platform does
    // not owe its own shop) and payoutSeller refuses it outright. So its stored balance is correctly 0
    // forever while the derived figure counts every house slice ever sold. Comparing the two reports a
    // huge phantom drift that is really just the house having no commission ledger at all.
    if (s.isHouse) {
      const houseAgg = await prisma.subOrder.aggregate({ _count: true, where: { sellerId: s.id } });
      console.log(`  [house] ${s.name}: no commission ledger by design (${houseAgg._count} slices) — skipped`);
      continue;
    }
    const agg = await prisma.subOrder.aggregate({
      _sum: { netPayable: true },
      _count: true,
      where: {
        sellerId: s.id,
        settled: false,
        status: { not: "CANCELLED" },
        order: { status: { not: "CANCELLED" } },
      },
    });
    const derived = r2(n(agg._sum.netPayable));
    const stored = r2(n(s.outstandingBalance));
    const delta = r2(stored - derived);
    const flag = Math.abs(delta) > 0.01 ? "  <-- DRIFT" : "";
    if (flag) drifted++;
    console.log(
      `  ${s.isHouse ? "[house] " : ""}${s.name}` +
        `\n      stored=${stored}  derived=${derived}  delta=${delta}` +
        `  (unsettled slices: ${agg._count})${flag}`,
    );
  }
  console.log(drifted === 0 ? "  => no drift" : `  => ${drifted} seller(s) drifted`);

  // ── 2. P1 double-payout fingerprint ──────────────────────────────────────────
  // A racing second payout re-claims the same SubOrders and overwrites payoutId, so the FIRST payout
  // is left holding money with no orders attached. That orphan is the tell.
  const payouts = await prisma.sellerPayout.findMany({
    select: { id: true, sellerId: true, netPaid: true, paidAt: true, mode: true, note: true },
    orderBy: { paidAt: "asc" },
  });
  console.log(`\n=== 2. P1 double-payout fingerprint (${payouts.length} payouts) ===`);
  let orphans = 0;
  for (const p of payouts) {
    const linked = await prisma.subOrder.count({ where: { payoutId: p.id } });
    if (linked === 0 && n(p.netPaid) > 0) {
      orphans++;
      console.log(
        `  ORPHAN payout ${p.id}  seller=${p.sellerId}  netPaid=${r2(n(p.netPaid))}` +
          `  paidAt=${p.paidAt?.toISOString?.() ?? p.paidAt}  mode=${p.mode ?? "-"}`,
      );
    }
  }
  console.log(orphans === 0
    ? "  => no orphaned payouts: no evidence P1 ever fired"
    : `  => ${orphans} orphaned payout(s) — P1 has fired`);

  // Cross-check: total paid out vs total netPayable of settled, non-cancelled slices.
  const settledAgg = await prisma.subOrder.aggregate({
    _sum: { netPayable: true },
    where: { settled: true, status: { not: "CANCELLED" }, order: { status: { not: "CANCELLED" } } },
  });
  const paidAgg = await prisma.sellerPayout.aggregate({ _sum: { netPaid: true } });
  console.log(
    `  cross-check: settled netPayable=${r2(n(settledAgg._sum.netPayable))}` +
      `  vs payouts netPaid=${r2(n(paidAgg._sum.netPaid))}` +
      `  delta=${r2(n(paidAgg._sum.netPaid) - n(settledAgg._sum.netPayable))}`,
  );

  // ── 3. P2 duplicate open cash declarations ───────────────────────────────────
  const pending = await prisma.cashSettlement.groupBy({
    by: ["deliveryBoyId"],
    where: { status: "PENDING" },
    _count: { _all: true },
  });
  const dupes = pending.filter((p) => p._count._all > 1);
  console.log(`\n=== 3. P2 duplicate open cash declarations ===`);
  console.log(`  riders with an open declaration: ${pending.length}`);
  console.log(dupes.length === 0
    ? "  => none duplicated"
    : `  => DUPLICATED: ${dupes.map((d) => `${d.deliveryBoyId} x${d._count._all}`).join(", ")}`);

  const totalSettlements = await prisma.cashSettlement.count();
  console.log(`  total CashSettlement rows: ${totalSettlements}`);
}

main()
  .catch((e) => { console.error("audit failed:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
