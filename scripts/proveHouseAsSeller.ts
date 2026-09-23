/**
 * Runbook step 23's prove, run against live data. Commits NOTHING.
 *
 * Its words: "The first order after the flip produces a non-zero SubOrder.commissionAmount for the
 * house seller, and the month's commission invoice bills it."
 *
 * ⚠️ THE FIRST HALF IS A REAL ROW, NOT A REPLAY. A pure recomputation of a stored slice would only
 * prove the arithmetic, and the arithmetic was never the doubt — step 09 already pinned it. What
 * step 23 changes is whether the WRITE path treats the shop as a separate party, so this plants a
 * genuine SubOrder through the same three calls routes/orders.ts makes at placement
 * (sumSellerLines -> computeSellerSplit -> tx.subOrder.create({...split})), reads it back OUT OF
 * THE DATABASE, and then throws so Prisma rolls the whole interactive transaction back. The
 * outstandingBalance increment is gated on the same isSameLegalEntity call the route uses, so if
 * the flag were wrong the balance would not move and the check would say so.
 *
 * ⚠️ THE SECOND HALF DELIBERATELY DOES NOT ISSUE AN INVOICE. generateCommissionInvoice writes with
 * its own transaction and its own invoice-number series, so it cannot join a rollback — calling it
 * for real would burn a number out of the platform's COM series to prove a point. Instead it is
 * called for a period with no house commission in it, and the SKIP REASON is the evidence: while
 * the entities were one it returned "house seller - the platform and the shop are one entity"
 * without ever looking at the money. Getting "no commission in this period" instead proves it is
 * now past that gate and reading the rows — which is the only thing step 23 changed about it.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/proveHouseAsSeller.ts'
 */
import { PrismaClient } from "@prisma/client";
import { TCS_RATE_PCT } from "../src/data/taxRates.js";
import { sumSellerLines, computeSellerSplit } from "../src/services/sellerSplit.js";
import { houseSellerIsSeparateEntity, isSameLegalEntity } from "../src/services/entitySplit.js";
import { generateCommissionInvoice } from "../src/services/commissionInvoice.js";
import { payableSubOrderWhere } from "../src/services/sellerPayout.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const ROLLBACK = "intentional rollback - the prove never commits";
const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);

async function main() {
  const house = await prisma.seller.findFirst({
    where: { isHouse: true },
    select: { id: true, name: true, isHouse: true, commissionPct: true, outstandingBalance: true },
  });
  if (!house) { console.log("No house seller - nothing to prove."); return; }

  const houseIsSeparate = await houseSellerIsSeparateEntity();
  const sameEntity = isSameLegalEntity(house, houseIsSeparate);
  console.log(`house seller: ${house.name}  commissionPct=${n(house.commissionPct)}%`);
  console.log(`houseSellerIsSeparateEntity = ${houseIsSeparate}`);
  console.log(
    `isSameLegalEntity(house) = ${sameEntity}  ` +
    `${sameEntity ? "- STILL EXEMPT, the split has not been applied" : "- the shop is a separate party now"}\n`,
  );

  // ── The past, which must not have moved ──────────────────────────────────────────────────
  const withCommission = await prisma.subOrder.count({
    where: { seller: { is: { isHouse: true } }, commissionAmount: { gt: 0 } },
  });
  const cfg = await prisma.storeConfig.findFirst({ select: { payoutHoldDays: true } });
  const stalePayable = await prisma.subOrder.aggregate({
    where: payableSubOrderWhere({ sellerId: house.id, payoutHoldDays: Math.max(0, cfg?.payoutHoldDays ?? 0) }),
    _sum: { netPayable: true },
    _count: { _all: true },
  });
  console.log("THE PAST");
  console.log(
    `  house slices carrying a commission: ${withCommission}` +
    `  ${withCommission === 0 ? "- none, nothing reached backwards" : "  WARNING"}`,
  );
  console.log(
    `  pre-split slices the payout query would pay: ${stalePayable._count._all}, ` +
    `${n(stalePayable._sum.netPayable).toFixed(2)}` +
    `  ${n(stalePayable._sum.netPayable) === 0 ? "- nothing owed for orders the shop invoiced itself" : "  WARNING"}\n`,
  );

  // ── The next order: a real row, written and read back, then rolled back ──────────────────
  const donor = await prisma.subOrder.findFirst({
    where: { sellerId: house.id, subtotal: { gt: 0 }, taxableValue: { not: null } },
    select: {
      orderId: true, subtotal: true, taxableValue: true,
      order: { select: { orderNumber: true } },
      items: { select: { lineTotal: true, taxableValue: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!donor || donor.items.length === 0) { console.log("No house slice with lines to model. Stopping."); return; }

  const lines = donor.items.map((i) => ({ lineTotal: n(i.lineTotal), taxableValue: n(i.taxableValue) }));
  const totals = sumSellerLines(lines, n(house.commissionPct));
  const split = computeSellerSplit({
    subtotal: totals.subtotal,
    taxableValue: totals.taxableValue,
    commissionPct: totals.commissionPct,
    commissionAmount: totals.commissionAmount,
    commissionGstAmount: totals.commissionGstAmount,
    tcsRatePct: TCS_RATE_PCT,
    tdsAmount: 0,
    // The exact expression routes/orders.ts evaluates at placement.
    isHouse: isSameLegalEntity(house, houseIsSeparate),
  });

  console.log(`A NEW HOUSE ORDER, modelled on ${donor.order.orderNumber} (${lines.length} line(s))`);
  let readBack: { commissionAmount: number; commissionGstAmount: number; tcsAmount: number; netPayable: number } | null = null;
  let balanceMoved = 0;
  try {
    await prisma.$transaction(async (tx) => {
      const planted = await tx.subOrder.create({
        data: { orderId: donor.orderId, sellerId: house.id, status: "PLACED", ...split },
        select: { id: true },
      });
      if (!isSameLegalEntity(house, houseIsSeparate)) {
        await tx.seller.update({
          where: { id: house.id },
          data: { outstandingBalance: { increment: split.netPayable } },
          select: { id: true },
        });
      }
      // Read it back out of the database rather than trusting the object we just passed in.
      const row = await tx.subOrder.findUniqueOrThrow({
        where: { id: planted.id },
        select: { commissionAmount: true, commissionGstAmount: true, tcsAmount: true, netPayable: true },
      });
      readBack = {
        commissionAmount: n(row.commissionAmount),
        commissionGstAmount: n(row.commissionGstAmount),
        tcsAmount: n(row.tcsAmount),
        netPayable: n(row.netPayable),
      };
      const s = await tx.seller.findUniqueOrThrow({ where: { id: house.id }, select: { outstandingBalance: true } });
      balanceMoved = r2(n(s.outstandingBalance) - n(house.outstandingBalance));
      throw new Error(ROLLBACK);
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
  }

  const rb = readBack as { commissionAmount: number; commissionGstAmount: number; tcsAmount: number; netPayable: number } | null;
  if (!rb) { console.log("  the planted row could not be read back. Stopping."); return; }
  console.log(`  gross ${split.subtotal.toFixed(2)}   taxable ${split.taxableValue.toFixed(2)}`);
  console.log(
    `  read back from the DB:  commission ${rb.commissionAmount.toFixed(2)} @${split.commissionPct}%   ` +
    `GST ${rb.commissionGstAmount.toFixed(2)}   TCS ${rb.tcsAmount.toFixed(2)}   net ${rb.netPayable.toFixed(2)}`,
  );
  console.log(
    `  SubOrder.commissionAmount > 0: ${rb.commissionAmount > 0}` +
    `  ${rb.commissionAmount > 0 ? "- the shop is charged like any other seller" : "  THE PROVE'S OWN TEST FAILS"}`,
  );
  console.log(
    `  outstandingBalance moved by ${balanceMoved.toFixed(2)}` +
    `  ${r2(balanceMoved) === r2(rb.netPayable) ? "- equals the net, so the platform now owes the shop" : "  MISMATCH"}\n`,
  );

  // ── The commission invoice, proven by which gate it stops at ─────────────────────────────
  const period = new Date().toISOString().slice(0, 7);
  const inv = await generateCommissionInvoice(house.id, period);
  const pastTheGate = inv.skipped !== "house seller - the platform and the shop are one entity";
  console.log("THE MONTH'S COMMISSION INVOICE");
  console.log(`  generateCommissionInvoice(${house.name}, ${period}) -> ${inv.skipped ?? `invoice ${inv.invoiceNumber}`}`);
  console.log(
    `  ${pastTheGate
      ? "- past the one-entity gate; it read the rows and found no commission in a period with no post-split orders yet"
      : "  STILL REFUSING as one entity - the invoice would never bill the shop"}\n`,
  );

  // ── Nothing may have escaped ─────────────────────────────────────────────────────────────
  const after = await prisma.seller.findUniqueOrThrow({
    where: { id: house.id },
    select: { outstandingBalance: true, commissionPct: true },
  });
  const slices = await prisma.subOrder.count({ where: { sellerId: house.id } });
  const invoices = await prisma.invoice.count({ where: { invoiceKind: "COMMISSION" } });
  const clean = r2(n(after.outstandingBalance)) === r2(n(house.outstandingBalance)) && invoices === 0;
  console.log(
    `CLEANUP: outstandingBalance ${n(after.outstandingBalance).toFixed(2)}, house slices ${slices}, ` +
    `commission invoices ${invoices}  ${clean ? "- rolled back, database as found" : "- NOT CLEAN"}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
