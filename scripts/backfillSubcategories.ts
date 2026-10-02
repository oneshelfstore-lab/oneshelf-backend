// One-off backfill for the category tree (CATALOG_PLAN.md phase 1): turns the free-text
// CatalogProduct.subcategory + the hardcoded data/subcategories.ts lists into real child Category rows
// and links every product to its node (leafCategoryId). categoryId is NOT touched (it stays the root).
//
// DRY RUN BY DEFAULT: prints what it would create/link and exits. Add --apply to write.
// Idempotent — re-running only creates missing nodes and links still-unlinked products.
//
//   Local:    npx tsx scripts/backfillSubcategories.ts            (dry run)
//             npx tsx scripts/backfillSubcategories.ts --apply
//   Railway:  DATABASE_URL="<external URL>" npx tsx scripts/backfillSubcategories.ts
//
// ⚠️ Read the dry-run list first: free-text has typos/near-duplicates ("Rice" vs "Rice "), which are merged
// case-insensitively and trimmed, but anything else becomes its own node — fix those in the Category Builder.
import { PrismaClient } from "@prisma/client";
import { SUBCATEGORIES } from "../src/data/subcategories.js";
import { childSlug } from "../src/services/categoryTree.js";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const roots = await prisma.category.findMany({ where: { parentId: null }, select: { id: true, slug: true, name: true } });
  const existing = await prisma.category.findMany({ select: { id: true, slug: true, parentId: true, name: true } });
  const usedSlugs = new Set(existing.map((c) => c.slug));
  let created = 0;
  let linked = 0;

  for (const root of roots) {
    const curated = SUBCATEGORIES[root.slug] ?? [];
    // Raw free-text values actually in use, with product counts.
    const raw = await prisma.catalogProduct.groupBy({
      by: ["subcategory"],
      where: { categoryId: root.id, leafCategoryId: null, subcategory: { not: null } },
      _count: { _all: true },
    });

    // name (case-insensitive, trimmed) → display name; curated spelling wins, else the most common raw spelling.
    const display = new Map<string, string>();
    curated.forEach((n) => display.set(n.toLowerCase(), n));
    for (const g of [...raw].sort((a, b) => b._count._all - a._count._all)) {
      const t = (g.subcategory ?? "").trim();
      if (t && !display.has(t.toLowerCase())) display.set(t.toLowerCase(), t);
    }
    if (display.size === 0) continue;

    console.log(`\n${root.name} (${root.slug})`);
    const childByKey = new Map(existing.filter((c) => c.parentId === root.id).map((c) => [c.name.trim().toLowerCase(), c.id]));
    let order = 0;
    for (const [key, name] of display) {
      const n = raw.filter((g) => (g.subcategory ?? "").trim().toLowerCase() === key).reduce((s, g) => s + g._count._all, 0);
      let id = childByKey.get(key);
      if (!id) {
        let slug = childSlug(root.slug, name);
        for (let i = 2; usedSlugs.has(slug); i++) slug = `${childSlug(root.slug, name).slice(0, 46)}_${i}`;
        usedSlugs.add(slug);
        console.log(`  + ${name}  (${n} products, slug ${slug})${curated.includes(name) ? "" : "   ← not in curated list"}`);
        if (APPLY) {
          id = (await prisma.category.create({ data: { slug, name, parentId: root.id, displayOrder: order } })).id;
        }
        created++;
      } else {
        console.log(`  = ${name}  (${n} products, node exists)`);
      }
      order++;
      if (APPLY && id) {
        // Link each raw spelling (exact string, so "Rice " and "rice" both match their own rows).
        for (const g of raw) {
          if ((g.subcategory ?? "").trim().toLowerCase() !== key) continue;
          const r = await prisma.catalogProduct.updateMany({
            where: { categoryId: root.id, leafCategoryId: null, subcategory: g.subcategory },
            data: { leafCategoryId: id },
          });
          linked += r.count;
        }
      }
    }
  }
  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN (nothing written)"}: ${created} node(s) ${APPLY ? "created" : "would be created"}, ${APPLY ? `${linked} product(s) linked` : "re-run with --apply to link products"}.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
