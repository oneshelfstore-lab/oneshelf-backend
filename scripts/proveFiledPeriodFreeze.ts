/**
 * Runbook step 18's prove, run for real against live data and then undone.
 *
 * Its words: "Mark a period filed, cancel an order inside it, re-run GSTR-8 for that period — the
 * number must not move. The current period shows the reversal."
 *
 * That is not a unit test. The freeze is a property of a query meeting a filing record and a
 * cancellation timestamp, and the only way to know those three agree is to make them happen.
 *
 * ⚠️ IT CANCELS A REAL ORDER AND THEN PUTS IT BACK. What it touches and restores: one Order's
 * status and cancelledAt, that order's SubOrder statuses, and the FiledTaxPeriod row it creates.
 * ⚠️ It calls the GSTR-8 aggregate directly and does NOT go through cancelOrderInTx — so no refund
 * is issued, no stock is restored, no ledger is reversed, no push is sent. It is a status flip and
 * its exact undo, which is what makes it safe to run against a live database.
 * The cleanup runs in a `finally` and every value is re-read afterwards to prove it was restored.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/proveFiledPeriodFreeze.ts'
 */
import { PrismaClient } from "@prisma/client";
import { TCS_RATE_PCT } from "../src/data/taxRates.js";
import {
  RETURN_TYPES,
  cancellationCutoff,
  reversibleFiledPeriods,
  periodWindow,
  periodOf,
} from "../src/services/filedPeriods.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

/**
 * The GSTR-8 TCS total for a period, applying the same filed-period rule the route does.
 *
 * ⚠️ Restated here rather than imported, and that is the one weakness of this script: the route
 * builds its aggregate inline, so this is a second copy of the predicate. It is kept deliberately
 * short and beside the original. If the two ever drift, the freeze stops being tested.
 */
async function gstr8Tcs(period: string): Promise<{ total: number; reversals: number }> {
  const { start, end } = periodWindow(period);
  const cutoff = await cancellationCutoff(RETURN_TYPES.GSTR8, period);
  const live = cutoff
    ? { OR: [{ status: { not: "CANCELLED" as const } }, { cancelledAt: { gt: cutoff } }] }
    : { status: { not: "CANCELLED" as const } };

  const rows = await prisma.subOrder.groupBy({
    by: ["sellerId"],
    where: { createdAt: { gte: start, lt: end }, tcsAmount: { gt: 0 }, order: { is: live } },
    _sum: { tcsAmount: true },
  });
  const total = rows.reduce((t, r) => t + Number(r._sum.tcsAmount ?? 0), 0);

  let reversals = 0;
  for (const f of await reversibleFiledPeriods(RETURN_TYPES.GSTR8, period)) {
    const w = periodWindow(f.period);
    const rv = await prisma.subOrder.groupBy({
      by: ["sellerId"],
      where: {
        createdAt: { gte: w.start, lt: w.end },
        tcsAmount: { gt: 0 },
        order: { is: { status: "CANCELLED", cancelledAt: { gt: f.filedAt, gte: start, lt: end } } },
      },
      _sum: { tcsAmount: true },
    });
    reversals -= rv.reduce((t, r) => t + Number(r._sum.tcsAmount ?? 0), 0);
  }
  return { total: Math.round(total * 100) / 100, reversals: Math.round(reversals * 100) / 100 };
}

async function main() {
  // A live order carrying TCS, in a month that has ended — the shape a filed period contains.
  const candidate = await prisma.subOrder.findFirst({
    where: {
      tcsAmount: { gt: 0 },
      order: { is: { status: { not: "CANCELLED" } } },
      createdAt: { lt: periodWindow(periodOf(new Date())).start },
    },
    select: { id: true, tcsAmount: true, orderId: true, createdAt: true, order: { select: { orderNumber: true, status: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (!candidate) { console.log("No TCS-bearing order in a closed month — nothing to freeze."); return; }

  const filedPeriod = periodOf(candidate.createdAt);
  const currentPeriod = periodOf(new Date());
  const tcs = Number(candidate.tcsAmount);
  console.log(`order ${candidate.order.orderNumber} — ${filedPeriod}, TCS ₹${tcs.toFixed(2)}`);
  console.log(`current period: ${currentPeriod}\n`);

  const original = { status: candidate.order.status };
  const subStatuses = await prisma.subOrder.findMany({
    where: { orderId: candidate.orderId }, select: { id: true, status: true },
  });
  const filedRowsBefore = await prisma.filedTaxPeriod.count();

  let filedMarked = false;
  let cancelled = false;
  try {
    const before = await gstr8Tcs(filedPeriod);
    console.log(`BEFORE   ${filedPeriod}: ₹${before.total.toFixed(2)}`);

    // 1. File the period.
    await prisma.filedTaxPeriod.create({
      data: { returnType: RETURN_TYPES.GSTR8, period: filedPeriod, filedBy: "prove-script", note: "temporary, removed by the script" },
    });
    filedMarked = true;

    // 2. Cancel an order inside it — status + timestamp only, nothing else the real path does.
    await prisma.order.update({
      where: { id: candidate.orderId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      select: { id: true },
    });
    await prisma.subOrder.updateMany({ where: { orderId: candidate.orderId }, data: { status: "CANCELLED" } });
    cancelled = true;

    // 3. Re-run the filed period. It must not move.
    const after = await gstr8Tcs(filedPeriod);
    const moved = Math.round((after.total - before.total) * 100) / 100;
    console.log(`AFTER    ${filedPeriod}: ₹${after.total.toFixed(2)}   moved ₹${moved.toFixed(2)}  ${moved === 0 ? "FROZEN" : "⚠️ MOVED"}`);

    // 4. The reversal must appear in the period it happened in.
    const current = await gstr8Tcs(currentPeriod);
    const expected = Math.round(-tcs * 100) / 100;
    console.log(`CURRENT  ${currentPeriod}: reversals ₹${current.reversals.toFixed(2)}  — expected ₹${expected.toFixed(2)}  ${current.reversals.toFixed(2) === expected.toFixed(2) ? "REPORTED" : "⚠️ MISSING"}`);

    // 5. And the control: with the period NOT filed, the same cancellation DOES remove it. That is
    //    the old behaviour, and it is what makes the freeze meaningful rather than a no-op.
    await prisma.filedTaxPeriod.deleteMany({ where: { returnType: RETURN_TYPES.GSTR8, period: filedPeriod } });
    filedMarked = false;
    const unfiled = await gstr8Tcs(filedPeriod);
    const dropped = Math.round((before.total - unfiled.total) * 100) / 100;
    console.log(`\nCONTROL  same cancellation, period NOT filed: ₹${unfiled.total.toFixed(2)}, dropped ₹${dropped.toFixed(2)}  — expected ₹${tcs.toFixed(2)}  ${dropped.toFixed(2) === tcs.toFixed(2) ? "as before step 18" : "⚠️ unexpected"}`);
  } finally {
    if (cancelled) {
      await prisma.order.update({
        where: { id: candidate.orderId },
        data: { status: original.status as any, cancelledAt: null },
        select: { id: true },
      });
      for (const s of subStatuses) {
        await prisma.subOrder.update({ where: { id: s.id }, data: { status: s.status }, select: { id: true } });
      }
    }
    if (filedMarked) {
      await prisma.filedTaxPeriod.deleteMany({ where: { returnType: RETURN_TYPES.GSTR8, period: filedPeriod } });
    }

    const restored = await prisma.order.findUnique({
      where: { id: candidate.orderId }, select: { status: true, cancelledAt: true },
    });
    const subsNow = await prisma.subOrder.findMany({ where: { orderId: candidate.orderId }, select: { id: true, status: true } });
    const subsOk = subStatuses.every((s) => subsNow.find((n) => n.id === s.id)?.status === s.status);
    const filedNow = await prisma.filedTaxPeriod.count();
    const clean = restored?.status === original.status && restored?.cancelledAt === null && subsOk && filedNow === filedRowsBefore;
    console.log(`\nCLEANUP: order ${restored?.status} (was ${original.status}), cancelledAt ${restored?.cancelledAt ?? "null"}, sub-orders ${subsOk ? "restored" : "⚠️ WRONG"}, filed rows ${filedRowsBefore}→${filedNow}  ${clean ? "— database as found" : "— ⚠️ NOT CLEAN"}`);
    void TCS_RATE_PCT;
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
