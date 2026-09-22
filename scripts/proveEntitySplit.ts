/**
 * Runbook step 09's prove, run against live data.
 *
 * Its words: "A house-seller order still produces zero commission, zero TCS, zero TDS. Then flip the
 * flag in a scratch database and confirm all three appear. Flip it back."
 *
 * ⚠️ THERE IS NO SCRATCH DATABASE, so the flip happens INSIDE A TRANSACTION THAT IS THEN ROLLED
 * BACK. Prisma rolls back the whole interactive transaction when its callback throws, so the flag is
 * visible to the real functions called inside it and to nothing else, and is never committed. That
 * matters more than it sounds: committing this flag even for a second would let any order placed in
 * that window accrue commission and TCS against the shop's own catalog, and a rollback cannot take
 * an already-placed order back.
 *
 * The money half is computed PURELY from a real slice's own stored numbers - no writes at all. The
 * transaction exists only to exercise the two things a pure function cannot: reading the real config
 * row, and the real Sec 194-O function no longer short-circuiting on isHouse.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/proveEntitySplit.ts'
 */
import { PrismaClient } from "@prisma/client";
import { TCS_RATE_PCT } from "../src/data/taxRates.js";
import { sumSellerLines, computeSellerSplit } from "../src/services/sellerSplit.js";
import { houseSellerIsSeparateEntity, isSameLegalEntity } from "../src/services/entitySplit.js";
import { computeSubOrderTds194o } from "../src/services/sellerTds194o.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const ROLLBACK = "intentional rollback - the prove never commits";
const n = (v: unknown) => Number(v ?? 0);

async function main() {
  const house = await prisma.seller.findFirst({
    where: { isHouse: true },
    select: { id: true, name: true, commissionPct: true, isHouse: true, pan: true, entityType: true },
  });
  if (!house) { console.log("No house seller - nothing to prove."); return; }

  const cfgBefore = await prisma.storeConfig.findFirst({
    select: { houseSellerIsSeparateEntity: true, tds194oEnabled: true, tds194oRatePct: true },
  });
  console.log(`house seller: ${house.name}  commissionPct=${house.commissionPct}`);
  console.log(`config: houseSellerIsSeparateEntity=${cfgBefore?.houseSellerIsSeparateEntity}  tds194oEnabled=${cfgBefore?.tds194oEnabled}\n`);

  // A real house slice, replayed both ways from its own stored numbers.
  const slice = await prisma.subOrder.findFirst({
    where: { sellerId: house.id, subtotal: { gt: 0 } },
    select: {
      subtotal: true, taxableValue: true, commissionAmount: true, tcsAmount: true, tdsAmount: true,
      netPayable: true, order: { select: { orderNumber: true } },
      items: { select: { lineTotal: true, taxableValue: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!slice) { console.log("No house slice with money - nothing to replay."); return; }

  const lines = slice.items.map((i) => ({ lineTotal: n(i.lineTotal), taxableValue: n(i.taxableValue) }));
  const replay = (houseIsSeparate: boolean, commissionPct: number) => {
    const totals = sumSellerLines(lines, commissionPct);
    return computeSellerSplit({
      subtotal: totals.subtotal,
      taxableValue: totals.taxableValue,
      commissionPct: totals.commissionPct,
      commissionAmount: totals.commissionAmount,
      tcsRatePct: TCS_RATE_PCT,
      tdsAmount: 0,
      isHouse: isSameLegalEntity(house, houseIsSeparate),
    });
  };

  const off = replay(false, n(house.commissionPct));
  console.log(`replaying ${slice.order.orderNumber} (${lines.length} line(s), subtotal ${off.subtotal})\n`);
  console.log(`  FLAG OFF   commission ${off.commissionAmount.toFixed(2)}   tcs ${off.tcsAmount.toFixed(2)}   tds 0.00   net ${off.netPayable.toFixed(2)}`);
  console.log(`  STORED     commission ${n(slice.commissionAmount).toFixed(2)}   tcs ${n(slice.tcsAmount).toFixed(2)}   tds ${n(slice.tdsAmount).toFixed(2)}   net ${n(slice.netPayable).toFixed(2)}`);
  const matchesStored =
    off.commissionAmount === n(slice.commissionAmount) &&
    off.tcsAmount === n(slice.tcsAmount) &&
    off.netPayable === n(slice.netPayable);
  console.log(`             ${matchesStored ? "- unchanged, as stored" : "  MISMATCH"}\n`);

  // ⚠️ The house rate is 0 in the live data, so flipping the flag alone starts no commission. The
  // replay is shown BOTH ways so the difference between "the flag does nothing" and "no rate is set
  // yet" is visible rather than inferred.
  const onAtZero = replay(true, n(house.commissionPct));
  const onAtFive = replay(true, 5);
  console.log(`  FLAG ON, rate ${house.commissionPct}%   commission ${onAtZero.commissionAmount.toFixed(2)}   tcs ${onAtZero.tcsAmount.toFixed(2)}   net ${onAtZero.netPayable.toFixed(2)}`);
  console.log(`  FLAG ON, rate 5%   commission ${onAtFive.commissionAmount.toFixed(2)}   tcs ${onAtFive.tcsAmount.toFixed(2)}   net ${onAtFive.netPayable.toFixed(2)}`);
  console.log(`             TCS appears from the statute; commission needs a rate set too (step 23).\n`);

  // The live half: the real config reader, and the real 194-O function, under a flipped flag that
  // is never committed.
  console.log(`  reader, uncommitted: houseSellerIsSeparateEntity() = ${await houseSellerIsSeparateEntity()}`);
  const tdsOff = await prisma.$transaction(async (tx) => computeSubOrderTds194o(tx, house, n(slice.subtotal)));
  console.log(`  194-O with the flag off: tds ${tdsOff.tdsAmount.toFixed(2)} at ${tdsOff.rateApplied}%`);

  let tdsOn = { tdsAmount: 0, rateApplied: 0 };
  let readerOn = false;
  try {
    await prisma.$transaction(async (tx) => {
      const cfg = await tx.storeConfig.findFirst({ select: { id: true } });
      await tx.storeConfig.update({
        where: { id: cfg!.id },
        data: { houseSellerIsSeparateEntity: true, tds194oEnabled: true },
        select: { id: true },
      });
      readerOn = await houseSellerIsSeparateEntity(tx);
      tdsOn = await computeSubOrderTds194o(tx, house, n(slice.subtotal));
      throw new Error(ROLLBACK);
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
  }
  console.log(`  reader, inside the flipped transaction: houseSellerIsSeparateEntity() = ${readerOn}`);
  console.log(`  194-O with the flag on:  tds ${tdsOn.tdsAmount.toFixed(2)} at ${tdsOn.rateApplied}%  ` +
    `${tdsOn.tdsAmount > 0 ? "- it no longer short-circuits on isHouse" : "  NOT CHARGED"}\n`);

  // Nothing may have escaped the rollback.
  const cfgAfter = await prisma.storeConfig.findFirst({
    select: { houseSellerIsSeparateEntity: true, tds194oEnabled: true },
  });
  const clean =
    cfgAfter?.houseSellerIsSeparateEntity === cfgBefore?.houseSellerIsSeparateEntity &&
    cfgAfter?.tds194oEnabled === cfgBefore?.tds194oEnabled;
  console.log(
    `CLEANUP: houseSellerIsSeparateEntity=${cfgAfter?.houseSellerIsSeparateEntity} ` +
    `tds194oEnabled=${cfgAfter?.tds194oEnabled}  ${clean ? "- rolled back, database as found" : "- NOT CLEAN"}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
