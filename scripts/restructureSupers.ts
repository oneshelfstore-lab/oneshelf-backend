// Moves the catalogue onto the 18 super-categories (src/data/superCategories.ts):
//   1. upsert the 18 supers with their departments;
//   2. stationery roots (slug "stationery_*")  → Stationery & Office;
//   3. every other active root → Grocery & Food;
//   4. deactivate the retired old supers (never deleted, so it's reversible: set isActive back).
// Products are untouched (they point at categories, not supers). Idempotent.
//
// DRY RUN BY DEFAULT. Add --apply to write.
//   DATABASE_URL="<external URL>" npx tsx scripts/restructureSupers.ts --apply
import { PrismaClient } from "@prisma/client";
import { SUPER_CATEGORIES, RETIRED_SUPERS, DELETED_SUPERS, STATIONERY_SUPER, DEFAULT_SUPER } from "../src/data/superCategories.js";

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

  const roots = await prisma.category.findMany({ where: { parentId: null, isActive: true }, select: { id: true, slug: true, superCategory: { select: { slug: true } } } });
  const target = (slug: string) => (slug.startsWith("stationery_") ? STATIONERY_SUPER : DEFAULT_SUPER);
  let moved = 0;
  for (const r of roots) {
    const to = target(r.slug);
    // Only roots with no super, or still on a retired one, are (re)homed. Re-running after a tree has been seeded
    // (seedTree.ts places its roots on its own super) must never drag those roots back to the default.
    const cur = r.superCategory?.slug;
    if (cur === to || (cur && !RETIRED_SUPERS.includes(cur))) continue;
    moved++;
    console.log(`root   ${r.slug.padEnd(34)} ${r.superCategory?.slug ?? "(none)"} → ${to}`);
    if (APPLY) await prisma.category.update({ where: { id: r.id }, data: { superCategoryId: ids.get(to)! } });
  }

  for (const slug of RETIRED_SUPERS) {
    const n = APPLY ? (await prisma.superCategory.updateMany({ where: { slug }, data: { isActive: false } })).count : null;
    console.log(`retire ${slug}${n === 0 ? "  (not in DB)" : ""}`);
  }
  for (const slug of DELETED_SUPERS) {
    const sup = await prisma.superCategory.findUnique({ where: { slug }, select: { id: true, _count: { select: { categories: true } } } });
    if (!sup) continue;
    const n = sup._count.categories;
    console.log(`delete ${slug}${n ? `  — SKIPPED, still has ${n} categor${n === 1 ? "y" : "ies"}` : ""}`);
    if (APPLY && !n) await prisma.superCategory.delete({ where: { id: sup.id } });
  }
  console.log(`\n${APPLY ? "Applied" : "Would apply"}: ${SUPER_CATEGORIES.length} supers, ${moved} roots moved, ${RETIRED_SUPERS.length} retired.${APPLY ? "" : " Dry run — add --apply."}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
