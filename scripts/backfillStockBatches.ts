import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * One-time backfill: give every existing ProductVariant with stock > 0 a single StockBatch so its
 * current stock isn't orphaned outside the new FIFO batch system (see services/stockBatches.ts).
 * The batch's cost is the variant's current costPrice (0 if never set — matches how a null cost
 * has always been treated everywhere else in this codebase, e.g. Catalog Health's
 * hasFullCostData flag). receivedAt is backdated to the variant's own createdAt so the batch
 * doesn't look like it just arrived today.
 *
 * Safe to re-run: skips any variant that already has at least one StockBatch, so a partial or
 * repeated run never double-seeds a variant.
 *
 * Run with: npx tsx scripts/backfillStockBatches.ts
 * (Not run by the agent — this touches the live database; run it yourself once, right after the
 * `prisma db push` that adds StockBatch/StockBatchConsumption/OrderItem.costPriceSnapshot, and
 * before deploying the code that reads from batches.)
 */
async function main() {
  const variants = await prisma.productVariant.findMany({
    where: { stock: { gt: 0 } },
    select: { id: true, stock: true, costPrice: true, createdAt: true },
  });

  let seeded = 0;
  let skipped = 0;

  for (const v of variants) {
    const existing = await prisma.stockBatch.findFirst({ where: { variantId: v.id }, select: { id: true } });
    if (existing) {
      skipped++;
      continue;
    }
    const qty = Number(v.stock);
    const unitCost = v.costPrice != null ? Number(v.costPrice) : 0;
    await prisma.stockBatch.create({
      data: {
        variantId: v.id,
        unitCost,
        qtyReceived: qty,
        qtyRemaining: qty,
        receivedAt: v.createdAt,
        note: "Backfilled from pre-batch stock",
      },
    });
    seeded++;
  }

  console.log(`Backfill complete: ${seeded} variant(s) seeded, ${skipped} already had batch data.`);
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
