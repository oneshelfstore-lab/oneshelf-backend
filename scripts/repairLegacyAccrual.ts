/**
 * One-off repair for the pre-July-2026 unreversed commission accruals.
 *
 * Two orders were cancelled BEFORE services/subOrderFulfillment.ts gained
 * reverseSellerLedgerOnCancel, so their seller slices stayed active and the accrual was never taken
 * back out of Seller.outstandingBalance. This does not hand-patch the number — it runs the real
 * reversal function, which flips those slices to CANCELLED and decrements by their own netPayable.
 *
 * Dry run:  railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/repairLegacyAccrual.ts'
 * Apply:    ... same, with --apply
 *
 * Idempotent: reverseSellerLedgerOnCancel only reverses slices it finds still active, so a second
 * run is a no-op.
 */
import prisma from "../src/lib/prisma.js";
import { reverseSellerLedgerOnCancel } from "../src/services/subOrderFulfillment.js";

const APPLY = process.argv.includes("--apply");
const ORDER_NUMBERS = ["ONS/2627/00013", "ONS/2627/00026"];
const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => Math.round(v * 100) / 100;

async function snapshot(label: string) {
  const sellers = await prisma.seller.findMany({
    where: { isHouse: false },
    select: { id: true, name: true, outstandingBalance: true },
    orderBy: { name: "asc" },
  });
  console.log(`\n--- ${label} ---`);
  for (const s of sellers) {
    const agg = await prisma.subOrder.aggregate({
      _sum: { netPayable: true },
      where: { sellerId: s.id, settled: false, status: { not: "CANCELLED" }, order: { status: { not: "CANCELLED" } } },
    });
    const stored = r2(n(s.outstandingBalance));
    const derived = r2(n(agg._sum.netPayable));
    const delta = r2(stored - derived);
    console.log(`  ${s.name}: stored=${stored} derived=${derived} delta=${delta}${Math.abs(delta) > 0.01 ? "  <-- DRIFT" : ""}`);
  }
}

/** Summed non-house outstandingBalance — the number a real reversal has to move. Narrow select on
 *  purpose: it must keep working even when the generated client is ahead of the live schema, which is
 *  the failure this script exists to survive. */
async function totalOwed(): Promise<number> {
  const rows = await prisma.seller.findMany({
    where: { isHouse: false },
    select: { outstandingBalance: true },
  });
  return r2(rows.reduce((t, s) => t + n(s.outstandingBalance), 0));
}

async function main() {
  console.log(APPLY ? "MODE: APPLY (will write)" : "MODE: DRY RUN (no writes)");

  const orders = await prisma.order.findMany({
    where: { orderNumber: { in: ORDER_NUMBERS } },
    select: {
      id: true, orderNumber: true, status: true,
      subOrders: {
        select: { id: true, status: true, settled: true, netPayable: true,
                  seller: { select: { name: true, isHouse: true } } },
      },
    },
  });

  if (orders.length !== ORDER_NUMBERS.length) {
    throw new Error(`Expected ${ORDER_NUMBERS.length} orders, found ${orders.length} — refusing.`);
  }

  // Preconditions. Refuse rather than repair something that isn't the case I audited.
  let expectedReversal = 0;
  for (const o of orders) {
    if (o.status !== "CANCELLED") throw new Error(`${o.orderNumber} is ${o.status}, not CANCELLED — refusing.`);
    const active = o.subOrders.filter((s) => s.status !== "CANCELLED");
    if (active.length === 0) {
      console.log(`  ${o.orderNumber}: already reversed, nothing to do`);
      continue;
    }
    for (const s of active) {
      // A SETTLED slice means the seller was already PAID for it — reversing the accrual then would
      // take back money that has left. That is clawback territory (cancelSubOrderAndRefund reports it
      // on a Complaint instead), so refuse rather than guess.
      if (s.settled) throw new Error(`${o.orderNumber} slice ${s.id} is already SETTLED (paid out) — refusing.`);
      // A HOUSE slice on a multi-seller order is expected and safe: reverseSellerLedgerOnCancel flips
      // it to CANCELLED but skips the decrement, because the platform never accrued against its own
      // shop in the first place (routes/orders.ts increments only `if (!seller.isHouse)`).
      if (s.seller.isHouse) {
        console.log(`  ${o.orderNumber}: slice ${s.status} / [house] -> will mark CANCELLED, no balance change`);
        continue;
      }
      expectedReversal += n(s.netPayable);
      console.log(`  ${o.orderNumber}: slice ${s.status} / ${s.seller.name} / netPayable ${r2(n(s.netPayable))} -> will reverse`);
    }
  }
  console.log(`\n  total to reverse: ${r2(expectedReversal)}`);

  await snapshot("BEFORE");

  if (!APPLY) {
    console.log("\nDry run complete — nothing written. Re-run with --apply to perform the reversal.");
    return;
  }

  // ⚠️ DO NOT TRUST THE CALL. reverseSellerLedgerOnCancel swallows its own errors by design — a
  // ledger reversal must never fail a customer's cancel in production — which makes it exactly the
  // wrong thing for a repair script to believe. The first run of this script printed "reversed" for
  // both orders while a P2022 rolled every transaction back underneath it: the generated client
  // expected Seller.busyUntil and the live database did not have that column yet. Nothing partial was
  // written (each reversal is transactional) and nothing said so either. Measure the balance instead.
  const owedBefore = await totalOwed();
  for (const o of orders) {
    await reverseSellerLedgerOnCancel(o.id);
  }
  const moved = r2(owedBefore - (await totalOwed()));

  await snapshot("AFTER");

  if (Math.abs(moved - r2(expectedReversal)) > 0.01) {
    throw new Error(
      `REVERSAL DID NOT TAKE — expected the owed total to fall by ${r2(expectedReversal)}, it fell by ${moved}.
  Each reversal is transactional, so nothing partial was written: the ledger is unchanged and safe to retry.
  Look above for a "seller ledger reversal failed" line — that is the real error, swallowed by design.
  Most likely cause: the generated Prisma client disagrees with the live database. Deploy the pending
  migration (or re-run 'npx prisma generate' against the deployed schema), then run this again.`,
    );
  }

  console.log();
  console.log(`  ✓ verified: owed total fell by ${moved}, matching the expected ${r2(expectedReversal)}`);
}

main().catch((e) => { console.error("repair failed:", e); process.exitCode = 1; })
      .finally(() => prisma.$disconnect());
