/**
 * Runbook step 20's prove, run against live data. Nothing is committed.
 *
 * Its words: "Approve a 2% rate, place an order, and confirm the new order carries 2% while an order
 * placed before approval still carries 5%. That is the snapshot doing its job."
 *
 * ⚠️ IT DOES NOT PLACE AN ORDER, and the substitution is deliberate rather than a shortcut. Placing
 * one writes an Order, its items, a SubOrder, a stock draw, an invoice, an OTP secret and a push —
 * inside a transaction this script would then roll back, against a live catalogue, for a customer
 * who does not exist. What the prove is actually asking is whether the rate a NEW line resolves to
 * follows the override while an OLD line keeps the rate it was written with. That is
 * resolveCommissionPct and a stored column, and both are exercised here directly.
 *
 * Everything happens inside a transaction that throws at the end, so the approval, the override and
 * the planted snapshot all vanish. The rate this touches is real money on every future order for
 * that product — it must not survive a prove.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/proveCommissionRequest.ts'
 */
import { PrismaClient } from "@prisma/client";
import { resolveCommissionPct } from "../src/services/sellerSplit.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const ROLLBACK = "intentional rollback - the prove never commits";
const ASK_PCT = 2;
const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);

async function main() {
  // A real external-seller product that has actually been sold, so there is an old line to compare.
  const item = await prisma.orderItem.findFirst({
    where: {
      variant: { is: { product: { is: { seller: { is: { isHouse: false } } } } } },
      lineTotal: { gt: 0 },
    },
    select: {
      id: true, productName: true, lineTotal: true, taxableValue: true, commissionPct: true,
      order: { select: { orderNumber: true } },
      subOrder: { select: { commissionPct: true } },
      variant: { select: { product: { select: { id: true, name: true, sellerId: true, commissionPctOverride: true, seller: { select: { name: true, commissionPct: true } } } } } },
    },
    orderBy: { id: "asc" },
  });
  if (!item?.variant) { console.log("No external-seller line to prove against."); return; }

  const product = item.variant.product;
  const sellerDefault = n(product.seller?.commissionPct);
  console.log(`product: ${product.name}  (${product.seller?.name})`);
  console.log(`seller default rate: ${sellerDefault}%   product override: ${product.commissionPctOverride ?? "none"}`);
  console.log(`existing line: ${item.order.orderNumber}  taxable ${n(item.taxableValue).toFixed(2)}` +
    `  line rate ${item.commissionPct == null ? "null (placed before step 08)" : n(item.commissionPct) + "%"}` +
    `  slice rate ${n(item.subOrder?.commissionPct)}%\n`);

  const requestsBefore = await prisma.commissionRequest.count();

  try {
    await prisma.$transaction(async (tx) => {
      // Stand in for "an order placed BEFORE approval". Every live line predates step 08 and carries
      // no rate of its own, so one is stamped here with what it was actually charged — the slice's
      // rate — to give the comparison something real to hold on to.
      const oldRate = n(item.subOrder?.commissionPct) || sellerDefault;
      await tx.orderItem.update({
        where: { id: item.id },
        data: { commissionPct: oldRate, commissionAmount: r2((n(item.taxableValue) * oldRate) / 100) },
        select: { id: true },
      });
      console.log(`planted: ${item.order.orderNumber} now carries its own snapshot of ${oldRate}% (uncommitted)`);

      // 1. The seller asks.
      const req = await tx.commissionRequest.create({
        data: {
          sellerId: product.sellerId!,
          productId: product.id,
          currentPct: sellerDefault,
          requestedPct: ASK_PCT,
          sellerNote: "prove script - rolled back",
        },
        select: { id: true, currentPct: true, requestedPct: true },
      });
      console.log(`request: ${n(req.currentPct)}% -> ${n(req.requestedPct)}%  (PENDING)`);

      // 2. The owner approves. Same two writes decideCommissionRequest makes, in one transaction.
      await tx.commissionRequest.update({
        where: { id: req.id },
        data: { status: "APPROVED", approvedPct: ASK_PCT, decidedAt: new Date() },
        select: { id: true },
      });
      await tx.catalogProduct.update({
        where: { id: product.id },
        data: { commissionPctOverride: ASK_PCT },
        select: { id: true },
      });

      const after = await tx.catalogProduct.findUnique({
        where: { id: product.id },
        select: { commissionPctOverride: true },
      });
      console.log(`approved: product override is now ${n(after?.commissionPctOverride)}%\n`);

      // 3. What the NEXT order's line would resolve to — the real function placement uses.
      const nextRate = resolveCommissionPct(
        { lineTotal: 0, taxableValue: 0, commissionPctOverride: n(after?.commissionPctOverride) },
        sellerDefault,
      );
      console.log(`  a NEW line resolves to ${nextRate}%  ${nextRate === ASK_PCT ? "- follows the override" : "  WRONG"}`);

      // 4. And the old line is untouched, because its rate is a snapshot rather than a lookup.
      const oldLine = await tx.orderItem.findUnique({
        where: { id: item.id },
        select: { commissionPct: true, commissionAmount: true },
      });
      const keptRate = n(oldLine?.commissionPct);
      console.log(`  the OLD line still carries ${keptRate}%` +
        `  ${keptRate === oldRate ? "- unmoved, the snapshot doing its job" : "  REWRITTEN"}`);
      console.log(`  and its commission is still ${n(oldLine?.commissionAmount).toFixed(2)},` +
        ` not the ${r2((n(item.taxableValue) * ASK_PCT) / 100).toFixed(2)} the new rate would give`);

      // 5. A second ask on the same product must be refused while one is open — the queue must never
      //    contain two answers to the same question.
      const open = await tx.commissionRequest.count({
        where: { productId: product.id, sellerId: product.sellerId!, status: "PENDING" },
      });
      console.log(`\n  open requests on this product after the decision: ${open}` +
        `  ${open === 0 ? "- decided, so a fresh ask is allowed" : "  still open"}`);

      throw new Error(ROLLBACK);
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
  }

  // ⚠️ THE WATCH, PROVED AGAINST THE DATABASE RATHER THAN THE FORM. A negative commission is the
  // platform paying the seller a fee - a supply in the opposite direction that the payout, the
  // commission invoice and GSTR-1 are all built the wrong way round for. A rule enforced only in a
  // route leaves every script, console session and future endpoint free to write one.
  let refused = "";
  try {
    await prisma.$transaction(async (tx) => {
      await tx.catalogProduct.update({
        where: { id: product.id },
        data: { commissionPctOverride: -1 },
        select: { id: true },
      });
      throw new Error(ROLLBACK);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    refused = msg === ROLLBACK ? "" : msg;
  }
  console.log(
    `\nnegative rate, written straight to the column: ` +
    (refused ? "REFUSED by the database check" : "  ACCEPTED - the constraint is missing"),
  );

  const requestsAfter = await prisma.commissionRequest.count();
  const prod = await prisma.catalogProduct.findUnique({
    where: { id: product.id }, select: { commissionPctOverride: true },
  });
  const line = await prisma.orderItem.findUnique({ where: { id: item.id }, select: { commissionPct: true } });
  const clean = requestsAfter === requestsBefore && prod?.commissionPctOverride == null && line?.commissionPct == null;
  console.log(
    `\nCLEANUP: requests ${requestsBefore}->${requestsAfter}, product override ` +
    `${prod?.commissionPctOverride ?? "null"}, line snapshot ${line?.commissionPct ?? "null"}` +
    `  ${clean ? "- rolled back, database as found" : "- NOT CLEAN"}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
