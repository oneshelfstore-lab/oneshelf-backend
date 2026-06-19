// One-off backfill: introduce the "house seller" (the current store) and attach every pre-existing
// catalog product + order item to it. After this runs, the multi-seller schema has no null seller
// anywhere and the single-store path keeps working unchanged ("a marketplace with one seller").
//
// Idempotent — safe to re-run (upserts the house seller by slug, only touches null-seller rows).
//
//   Local:   npx tsx scripts/backfillHouseSeller.ts
//   Render:  DATABASE_URL="<oneshelf-db external URL>" npx tsx scripts/backfillHouseSeller.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const HOUSE_SLUG = "house";

async function main() {
  // 1. Ensure the house seller exists (APPROVED, isHouse). Seed its identity from StoreConfig.
  //    commissionPct = 0 — the platform doesn't take commission from its own store, so platform
  //    "commission earned" stays honest (no self-dealing inflation).
  const store = await prisma.storeConfig.findFirst();
  const house = await prisma.seller.upsert({
    where: { slug: HOUSE_SLUG },
    update: {},
    create: {
      slug: HOUSE_SLUG,
      name: store?.storeName ?? "Oneshelf",
      isHouse: true,
      status: "APPROVED",
      commissionPct: 0,
      shopAddress: store?.storeAddress ?? null,
      phone: store?.storePhone ?? null,
      gstin: store?.gstin ?? null,
      pan: store?.pan ?? null,
    },
  });
  console.log(`House seller: ${house.id} (slug=${house.slug}, name=${house.name})`);

  // 2. Backfill products with no seller → house.
  const prod = await prisma.catalogProduct.updateMany({
    where: { sellerId: null },
    data: { sellerId: house.id },
  });
  console.log(`Products backfilled: ${prod.count}`);

  // 3. Backfill order items with no seller → house. (Historical SubOrders are NOT created — the
  //    commission ledger starts fresh at deploy, since the platform never actually deducted from
  //    past orders. New orders get split into SubOrders at placement.)
  const items = await prisma.orderItem.updateMany({
    where: { sellerId: null },
    data: { sellerId: house.id },
  });
  console.log(`Order items backfilled: ${items.count}`);
}

main()
  .then(() => console.log("✅ Backfill complete"))
  .catch((e) => {
    console.error("❌ Backfill failed", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
