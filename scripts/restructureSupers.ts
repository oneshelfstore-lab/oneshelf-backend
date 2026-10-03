// Moves the catalogue onto the 18 super-categories (src/data/superCategories.ts):
//   1. upsert the 18 supers with their departments;
//   2. stationery roots (slug "stationery_*")  → Stationery & Office;
//   3. every other root except the seasonal Diwali ones → Grocery & Food;
//   4. deactivate the retired old supers (never deleted, so it's reversible: set isActive back).
// Products are untouched (they point at categories, not supers). Idempotent.
//
// DRY RUN BY DEFAULT. Add --apply to write.
//   DATABASE_URL="<external URL>" npx tsx scripts/restructureSupers.ts --apply
import { PrismaClient } from "@prisma/client";
import { SUPER_CATEGORIES, RETIRED_SUPERS, DIWALI_ROOTS, STATIONERY_SUPER, DEFAULT_SUPER } from "../src/data/superCategories.js";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const ids = new Map<string, string>();
  for (const [i, s] of SUPER_CATEGORIES.entries()) {
    console.log(`super  ${String(i + 1).padStart(2)}  ${s.name.padEnd(26)} ← ${s.departments.join(", ")}`);
    if (APPLY) {
      const row = await prisma.superCategory.upsert({
        where: { slug: s.slug },
        update: { name: s.name, departments: s.departments, displayOrder: i + 1, isActive: true },
        create: { slug: s.slug, name: s.name, departments: s.departments, displayOrder: i + 1 },
      });
      ids.set(s.slug, row.id);
    }
  }

  const roots = await prisma.category.findMany({ where: { parentId: null }, select: { id: true, slug: true, superCategory: { select: { slug: true } } } });
  const target = (slug: string) => (slug.startsWith("stationery_") ? STATIONERY_SUPER : DIWALI_ROOTS.includes(slug) ? null : DEFAULT_SUPER);
  let moved = 0;
  for (const r of roots) {
    const to = target(r.slug);
    if (!to || r.superCategory?.slug === to) continue;
    moved++;
    console.log(`root   ${r.slug.padEnd(34)} ${r.superCategory?.slug ?? "(none)"} → ${to}`);
    if (APPLY) await prisma.category.update({ where: { id: r.id }, data: { superCategoryId: ids.get(to)! } });
  }

  for (const slug of RETIRED_SUPERS) {
    const n = APPLY ? (await prisma.superCategory.updateMany({ where: { slug }, data: { isActive: false } })).count : null;
    console.log(`retire ${slug}${n === 0 ? "  (not in DB)" : ""}`);
  }
  console.log(`\n${APPLY ? "Applied" : "Would apply"}: ${SUPER_CATEGORIES.length} supers, ${moved} roots moved, ${RETIRED_SUPERS.length} retired.${APPLY ? "" : " Dry run — add --apply."}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
