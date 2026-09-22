/**
 * Runbook step 19's prove, run against live data.
 *
 * Its words: "The summary tab's net equals the SellerPayout.netPaid for that period, to the paise."
 *
 * ⚠️ THERE HAVE BEEN ZERO PAYOUTS EVER, so there is nothing to compare against — the prove has to
 * make one. It runs the REAL payout path (payoutSellerInTx, the same function the owner's button and
 * the auto-payout cron both call) INSIDE A TRANSACTION THAT IS THEN ROLLED BACK. Prisma rolls back
 * the whole interactive transaction when its callback throws, so the payout exists for the statement
 * to read and for nothing else. Nothing is committed.
 *
 * Rolling back rather than undoing by hand matters here more than anywhere else in this runbook: a
 * payout writes a SellerPayout row, flips every covered slice to settled with a payoutId, claims any
 * pending adjustments, decrements Seller.outstandingBalance and may write a TDS register row. An
 * "undo" would have to reverse all six correctly, and getting one wrong leaves a seller's ledger
 * quietly wrong. A rollback cannot get it partly right.
 *
 * ⚠️ IT ALSO STAMPS ONE SLICE WITH A COMMISSION GST before paying out, and that is the point of the
 * whole exercise. Every live slice predates runbook step 07 and withheld no GST on its commission,
 * so a payout of today's data would reconcile whether or not SellerPayout.commissionGst is summed
 * correctly. Planting one post-step-07 slice is what makes the check able to fail.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/provePayoutStatement.ts'
 */
import { PrismaClient } from "@prisma/client";
import { payoutSellerInTx, payableSubOrderWhere, resolvePayoutSettings } from "../src/services/sellerPayout.js";
import { buildSettlementStatement } from "../src/services/settlementStatement.js";
import { COMMISSION_GST_RATE_PCT, commissionWithGst } from "../src/data/commissionTax.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const ROLLBACK = "intentional rollback - the prove never commits";
const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);

async function main() {
  const { payoutHoldDays } = await resolvePayoutSettings();

  // A NON-HOUSE seller with something actually payable — delivered, unsettled, past any hold.
  //
  // ⚠️ The house filter is not tidiness. The house store is the platform, so it accrues no balance
  // and charges itself no commission: a payout of its slices would prove nothing (every deduction is
  // zero) and would decrement an outstandingBalance that was never credited. An earlier run of this
  // script picked it, which is how the guard turned out to be missing from payoutSellerInTx.
  const payable = await prisma.subOrder.groupBy({
    by: ["sellerId"],
    where: { ...payableSubOrderWhere({ payoutHoldDays }), seller: { is: { isHouse: false } } },
    _sum: { netPayable: true },
    _count: true,
  });
  if (payable.length === 0) { console.log("Nothing is payable right now — no statement to prove."); return; }

  const target = payable.sort((a, b) => n(b._sum.netPayable) - n(a._sum.netPayable))[0]!;
  const seller = await prisma.seller.findUnique({
    where: { id: target.sellerId },
    select: { id: true, name: true, pan: true, isHouse: true, outstandingBalance: true },
  });
  if (!seller) { console.log("Seller vanished between reads — nothing to do."); return; }

  console.log(`seller: ${seller.name}`);
  console.log(`payable now: ${target._count} slice(s), net ₹${r2(n(target._sum.netPayable)).toFixed(2)}`);
  console.log(`outstandingBalance: ₹${r2(n(seller.outstandingBalance)).toFixed(2)}\n`);

  const payoutsBefore = await prisma.sellerPayout.count();

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Plant one post-step-07 slice so the commission-GST column is actually exercised.
      const one = await tx.subOrder.findFirst({
        where: payableSubOrderWhere({ sellerId: seller.id, payoutHoldDays }),
        select: { id: true, commissionAmount: true, netPayable: true, order: { select: { orderNumber: true } } },
        orderBy: { createdAt: "asc" },
      });
      if (!one) throw new Error("payable set emptied between reads");
      const gst = commissionWithGst(n(one.commissionAmount)).gst;
      await tx.subOrder.update({
        where: { id: one.id },
        data: {
          commissionGstPct: COMMISSION_GST_RATE_PCT,
          commissionGstAmount: gst,
          // netPayable has to move with it, exactly as placement would have written it.
          netPayable: r2(n(one.netPayable) - gst),
        },
        select: { id: true },
      });
      console.log(`planted: ${one.order.orderNumber} carries ₹${gst.toFixed(2)} of commission GST (uncommitted)\n`);

      // 2. The real payout path.
      const { payout, count } = await payoutSellerInTx(tx, seller.id, seller, {
        mode: "BANK_TRANSFER",
        note: "prove script - rolled back",
        payoutHoldDays,
      });
      console.log(`payout created (uncommitted): ${count} slice(s) settled`);
      console.log(
        `  gross ${n(payout.grossAmount).toFixed(2)}  commission ${n(payout.commission).toFixed(2)}` +
        `  commGST ${n(payout.commissionGst).toFixed(2)}  tcs ${n(payout.tcs).toFixed(2)}` +
        `  tds ${n(payout.tds).toFixed(2)}  adj ${n(payout.adjustmentTotal).toFixed(2)}` +
        `  -> netPaid ${n(payout.netPaid).toFixed(2)}`,
      );

      // 3. The statement, read through the same transaction.
      const st = await buildSettlementStatement(seller.id, payout.id, tx);
      console.log(`\nstatement: ${st.summary.orderCount} order(s), ${st.lines.length} line(s)`);
      console.log(
        `  summary net ${st.summary.netPaid.toFixed(2)}  vs SellerPayout.netPaid ${n(payout.netPaid).toFixed(2)}` +
        `  ${st.summary.netPaid === n(payout.netPaid) ? "- MATCHES to the paise" : "  MISMATCH"}`,
      );
      console.log(
        `  reconciles: ${st.summary.reconciles ? "YES" : "NO"}` +
        `  (gross - commission - commGST - tcs - tds + adj vs netPaid, gap ${st.summary.reconciliationGap.toFixed(2)})`,
      );
      console.log(`  commission GST on the statement: ${st.summary.commissionGst.toFixed(2)}` +
        `  ${st.summary.commissionGst === gst ? "- the planted slice is in the batch" : "  NOT CARRIED"}`);

      // ⚠️ The check that can actually fail. Before SellerPayout.commissionGst existed, the summed
      // components could not reproduce netPaid the moment a slice withheld commission GST.
      const sum = st.summary;
      const expected = r2(sum.gross - sum.commission - sum.commissionGst - sum.tcs - sum.tds + sum.adjustments);
      console.log(
        `\n  ${sum.gross.toFixed(2)} - ${sum.commission.toFixed(2)} - ${sum.commissionGst.toFixed(2)}` +
        ` - ${sum.tcs.toFixed(2)} - ${sum.tds.toFixed(2)} + ${sum.adjustments.toFixed(2)} = ${expected.toFixed(2)}` +
        `  ${expected === sum.netPaid ? "- equals netPaid" : `  != netPaid ${sum.netPaid.toFixed(2)}`}`,
      );

      // 4. Per-line rates are present and add up to the slice — the reason the Lines tab exists.
      const lineSum = r2(st.lines.reduce((t, l) => t + (l.commissionAmount ?? 0), 0));
      const withRate = st.lines.filter((l) => l.commissionPct != null).length;
      console.log(
        `\n  lines carrying their own rate: ${withRate} of ${st.lines.length}` +
        `  (null = placed before step 08)` +
        `\n  line commission sums to ${lineSum.toFixed(2)} vs slice commission ${sum.commission.toFixed(2)}` +
        `  ${lineSum === sum.commission ? "- reconciles" : withRate === 0 ? "- n/a, no per-line rates yet" : "  MISMATCH"}`,
      );

      throw new Error(ROLLBACK);
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
  }

  // Nothing may have escaped.
  const payoutsAfter = await prisma.sellerPayout.count();
  const stillPayable = await prisma.subOrder.count({ where: payableSubOrderWhere({ sellerId: seller.id, payoutHoldDays }) });
  const after = await prisma.seller.findUnique({ where: { id: seller.id }, select: { outstandingBalance: true } });
  const gstStamped = await prisma.subOrder.count({ where: { sellerId: seller.id, commissionGstAmount: { not: null } } });
  const clean =
    payoutsAfter === payoutsBefore &&
    stillPayable === target._count &&
    r2(n(after?.outstandingBalance)) === r2(n(seller.outstandingBalance)) &&
    gstStamped === 0;
  console.log(
    `\nCLEANUP: payouts ${payoutsBefore}->${payoutsAfter}, payable slices ${stillPayable} (was ${target._count}),` +
    ` balance ${r2(n(after?.outstandingBalance)).toFixed(2)}, commission-GST stamps ${gstStamped}` +
    `  ${clean ? "- rolled back, database as found" : "- NOT CLEAN"}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
