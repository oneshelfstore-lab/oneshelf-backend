// Diwali is a festival shelf (a Collection the admin fills with any products), not a category or a super-category.
// This undoes the earlier mistake of treating it as one:
//   1. products filed under the "diwali" category (incense) → Spiritual & Pooja's Dhoopbatti sub-category;
//   2. "diwali" category and the Diwali super-category → deactivated (kept, reversible);
//   3. Spiritual & Pooja (a real year-round category) → Grocery & Food;
//   4. an empty "Diwali" OCCASION collection is created. Collections with no products stay hidden, so it appears
//      on Home only once the admin pins products to it.
// Idempotent. DRY RUN BY DEFAULT; add --apply.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const [diwali, spiritual, grocery, diwaliSuper] = await Promise.all([
    prisma.category.findUnique({ where: { slug: "diwali" }, select: { id: true } }),
    prisma.category.findUnique({ where: { slug: "spiritual_pooja_essential" }, select: { id: true } }),
    prisma.superCategory.findUnique({ where: { slug: "grocery_food" }, select: { id: true } }),
    prisma.superCategory.findUnique({ where: { slug: "diwali" }, select: { id: true } }),
  ]);
  if (!spiritual || !grocery) throw new Error("spiritual_pooja_essential or grocery_food missing — run restructureSupers.ts first");

  const dhoop = await prisma.category.findFirst({ where: { parentId: spiritual.id, name: { equals: "Dhoopbatti", mode: "insensitive" } }, select: { id: true } });
  const products = diwali ? await prisma.catalogProduct.findMany({ where: { categoryId: diwali.id }, select: { id: true, name: true } }) : [];
  for (const p of products) console.log(`product  ${p.name} → Spiritual & Pooja${dhoop ? " / Dhoopbatti" : ""}`);
  console.log(`category spiritual_pooja_essential → Grocery & Food`);
  console.log(`retire   category 'diwali'${diwali ? "" : " (absent)"}, super-category 'diwali'${diwaliSuper ? "" : " (absent)"}`);
  console.log(`create   collection 'Diwali' (OCCASION, empty, hidden until products are pinned)`);

  if (APPLY) {
    if (diwali && products.length) {
      await prisma.catalogProduct.updateMany({
        where: { categoryId: diwali.id },
        data: { categoryId: spiritual.id, leafCategoryId: dhoop?.id ?? null, subcategory: "Dhoopbatti" },
      });
    }
    await prisma.category.update({ where: { id: spiritual.id }, data: { superCategoryId: grocery.id } });
    if (diwali) await prisma.category.update({ where: { id: diwali.id }, data: { isActive: false, superCategoryId: null } });
    if (diwaliSuper) await prisma.superCategory.update({ where: { id: diwaliSuper.id }, data: { isActive: false } });
    await prisma.collection.upsert({
      where: { slug: "diwali" },
      update: {},
      create: { slug: "diwali", name: "Diwali", kind: "OCCASION", mode: "MANUAL", showOn: ["HOME"], displayOrder: 1 },
    });
  }
  console.log(APPLY ? "\nApplied." : "\nDry run — add --apply.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
