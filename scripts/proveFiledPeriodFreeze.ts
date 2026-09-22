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
import { RETURN_TYPES, periodWindow, periodOf } from "../src/services/filedPeriods.js";
import { buildGstr8 } from "../src/services/gstr8.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

/**
 * The GSTR-8 TCS total for a period, split into ordinary supply rows and reversals of already-filed
 * periods.
 *
 * ⚠️ IT CALLS THE REAL AGGREGATE. Until runbook step 19 the route built its return inline, so this
 * script could only RESTATE the filed-period predicate — a second copy that would keep passing after
 * the real one broke. services/gstr8.ts is now the one implementation and this runs it, which is the
 * only arrangement in which the word "prove" means anything.
 *
 * Reversal rows are told apart by `reversalOf`, never by matching their label: the label exists for
 * a human reading the return and is free to be reworded.
 */
async function gstr8Tcs(period: string): Promise<{ total: number; reversals: number }> {
  const r = await buildGstr8(period);
  const sum = (pred: (row: (typeof r.rows)[number]) => boolean) =>
    Math.round(r.rows.filter(pred).reduce((t, row) => t + row.tcsTotal, 0) * 100) / 100;
  return { total: sum((row) => row.reversalOf == null), reversals: sum((row) => row.reversalOf != null) };
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
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
