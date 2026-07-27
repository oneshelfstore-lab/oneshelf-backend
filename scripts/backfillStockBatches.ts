import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// `railway run` injects the INTERNAL DATABASE_URL (postgres.railway.internal), which only resolves
// from inside Railway's network — prefer the public proxy URL so this is runnable from a laptop.
// Falls back to DATABASE_URL when running inside Railway (or against a local .env).
const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
});

/**
 * One-time backfill: give every existing ProductVariant with stock > 0 a single StockBatch so its
 * current stock isn't orphaned outside the new FIFO batch system (see services/stockBatches.ts).
 * The batch's cost is the variant's current costPrice (0 if never set — matches how a null cost
 * has always been treated everywhere else in this codebase, e.g. Catalog Health's
 * hasFullCostData flag). receivedAt is backdated to the variant's own createdAt so the batch
 * doesn't look like it just arrived today.
 *
 * Safe to re-run: seeds only the SHORTFALL between the ProductVariant.stock rollup (what the app
 * shows, gates the stepper on, and validates the cart against) and the sum of qtyRemaining across
 * that variant's batches (what order placement actually draws down). A variant already fully backed
 * by batches has shortfall 0 and is skipped, so repeated runs never double-seed. Any variant with a
 * shortfall is currently UNBUYABLE above the batch total — the app shows it in stock and only fails
 * at Place Order with "Insufficient stock for X".
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
    const backed = await prisma.stockBatch.aggregate({
      where: { variantId: v.id },
      _sum: { qtyRemaining: true },
    });
    const qty = Number(v.stock) - Number(backed._sum.qtyRemaining ?? 0);
    if (qty <= 1e-9) {
      skipped++;
      continue;
    }
    const unitCost = v.costPrice != null ? Number(v.costPrice) : 0;
    await prisma.stockBatch.create({
      data: {
        variantId: v.id,
        unitCost,
        qtyReceived: qty,
        qtyRemaining: qty,
        receivedAt: v.createdAt,
        note: "Backfilled from pre-batch stock (shortfall vs rollup)",
      },
    });
    seeded++;
  }

  console.log(`Backfill complete: ${seeded} variant(s) seeded, ${skipped} already fully batch-backed.`);
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
