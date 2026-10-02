// Seeds the stationery tree (src/data/stationeryCatalog.ts): super-categories → roots → children → grandchildren,
// with each node's product-form fieldSchema. Existing nodes are matched by slug and updated in place, so a
// re-run is safe and never creates duplicates or touches products.
//
// DRY RUN BY DEFAULT (prints the tree it would write). Add --apply to write.
//   npx tsx scripts/seedStationery.ts
//   DATABASE_URL="<external URL>" npx tsx scripts/seedStationery.ts --apply
import { PrismaClient } from "@prisma/client";
import { STATIONERY, type Node } from "../src/data/stationeryCatalog.js";
import { childSlug } from "../src/services/categoryTree.js";
import { fieldSchemaSchema } from "../src/services/categoryFields.js";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const rootSlug = (name: string) => "stationery_" + name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

async function main() {
  let nodes = 0;
  let withFields = 0;

  /** childSlug truncates to 50 chars, so deep sibling names can collide. Suffixing is deterministic (same tree → same
   *  slugs), so a re-run lands on the same rows. Slugs are internal; nothing user-facing shows them. */
  const taken = new Set<string>();
  const uniqueSlug = (parent: string, name: string) => {
    let s = childSlug(parent, name);
    for (let i = 2; taken.has(s); i++) s = `${childSlug(parent, name).slice(0, 46)}_${i}`;
    taken.add(s);
    return s;
  };

  async function writeNode(node: Node, slug: string, parentId: string | null, superId: string | null, order: number, depth: number) {
    if (node.f) fieldSchemaSchema.parse(node.f); // fail loudly on a bad template, before any write
    nodes++;
    if (node.f?.length) withFields++;
    console.log(`${"  ".repeat(depth)}${node.n}${node.f?.length ? `  [${node.f.map((f) => f.key).join(", ")}]` : ""}`);
    let id = `dry:${slug}`;
    if (APPLY) {
      const data = { name: node.n, displayOrder: order, parentId, superCategoryId: superId, fieldSchema: node.f?.length ? (node.f as any) : undefined };
      id = (await prisma.category.upsert({ where: { slug }, update: data, create: { slug, ...data } })).id;
    }
    const kids = node.k ?? [];
    for (let i = 0; i < kids.length; i++) await writeNode(kids[i]!, uniqueSlug(slug, kids[i]!.n), id, null, i, depth + 1);
  }

  for (let si = 0; si < STATIONERY.length; si++) {
    const sup = STATIONERY[si]!;
    console.log(`\n▌${sup.name}`);
    let superId = `dry:${sup.slug}`;
    if (APPLY) {
      superId = (await prisma.superCategory.upsert({ where: { slug: sup.slug }, update: { name: sup.name, displayOrder: 100 + si }, create: { slug: sup.slug, name: sup.name, displayOrder: 100 + si } })).id;
    }
    for (let ri = 0; ri < sup.roots.length; ri++) {
      const r = sup.roots[ri]!;
      taken.add(rootSlug(r.n));
      await writeNode(r, rootSlug(r.n), null, superId, ri, 1);
    }
  }
  console.log(`\n${APPLY ? "Wrote" : "Would write"} ${nodes} category nodes (${withFields} with field templates) under ${STATIONERY.length} super-categories.`);
  if (!APPLY) console.log("Dry run — re-run with --apply to write.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
