// Seeds one category tree from src/data/catalogTrees.ts: roots → children → grandchildren, each node's
// product-form fieldSchema, the roots placed on their super-category. Nodes are matched by slug and updated in
// place, so a re-run is safe and never creates duplicates. Optional `moves` re-file existing products into the tree
// and `retireRoots` deactivates old roots the tree replaces (only once they're empty).
//
// DRY RUN BY DEFAULT (prints the tree it would write). Add --apply to write. The super-category must already exist
// (scripts/restructureSupers.ts).
//   npx tsx scripts/seedTree.ts fresh_dairy
//   DATABASE_URL="<external URL>" npx tsx scripts/seedTree.ts fresh_dairy --apply
import { mkdirSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { TREES } from "../src/data/catalogTrees.js";
import type { Node } from "../src/data/stationeryCatalog.js";
import { childSlug, subtreeIds } from "../src/services/categoryTree.js";
import { fieldSchemaSchema } from "../src/services/categoryFields.js";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const treeName = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "";
const slugify = (name: string) => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

async function main() {
  const tree = TREES[treeName];
  if (!tree) throw new Error(`Usage: seedTree.ts <${Object.keys(TREES).join("|")}> [--apply]`);

  let nodes = 0;
  let withFields = 0;
  const idByPath = new Map<string, { id: string | null; name: string; rootId: string }>(); // "Dairy>Milk>Toned Milk"
  const touched = new Set<string>(); // ids of every node this run wrote (to prune stale ones under reused roots)
  const undo: { id: string; categoryId: string; leafCategoryId: string | null; subcategory: string | null }[] = [];

  /** childSlug truncates to 50 chars, so deep sibling names can collide. Suffixing is deterministic (same tree → same
   *  slugs), so a re-run lands on the same rows. Slugs are internal; nothing user-facing shows them. */
  const taken = new Set<string>();
  const uniqueSlug = (parent: string, name: string) => {
    let s = childSlug(parent, name);
    for (let i = 2; taken.has(s); i++) s = `${childSlug(parent, name).slice(0, 46)}_${i}`;
    taken.add(s);
    return s;
  };

  async function writeNode(node: Node, path: string, slug: string, parentId: string | null, superId: string | null, rootId: string | null, order: number, depth: number) {
    if (node.f) fieldSchemaSchema.parse(node.f); // fail loudly on a bad template, before any write
    nodes++;
    if (node.f?.length) withFields++;
    console.log(`${"  ".repeat(depth)}${node.n}${node.f?.length ? `  [${node.f.map((f) => f.key).join(", ")}]` : ""}`);
    let id: string | null = null;
    if (APPLY) {
      const data = { name: node.n, displayOrder: order, parentId, superCategoryId: superId, fieldSchema: node.f?.length ? (node.f as any) : undefined, isActive: true };
      id = (await prisma.category.upsert({ where: { slug }, update: data, create: { slug, ...data } })).id;
      touched.add(id);
    }
    idByPath.set(path, { id, name: node.n, rootId: rootId ?? id ?? slug });
    const kids = node.k ?? [];
    for (let i = 0; i < kids.length; i++) {
      await writeNode(kids[i]!, `${path}>${kids[i]!.n}`, uniqueSlug(slug, kids[i]!.n), id, null, rootId ?? id ?? slug, i, depth + 1);
    }
  }

  const sup = await prisma.superCategory.findUnique({ where: { slug: tree.superSlug }, select: { id: true } });
  if (!sup && APPLY) throw new Error(`Super-category '${tree.superSlug}' does not exist: run scripts/restructureSupers.ts --apply first`);
  const superId = sup?.id ?? `dry:${tree.superSlug}`;

  for (const [i, r] of tree.roots.entries()) {
    const slug = r.slug ?? tree.prefix + slugify(r.n);
    taken.add(slug);
    await writeNode(r, r.n, slug, null, superId, null, i, 0);
  }

  let moved = 0;
  for (const m of tree.moves ?? []) {
    const target = idByPath.get(m.path.join(">"));
    if (!target) throw new Error(`move '${m.name ?? m.subcategory}': no node at ${m.path.join(" > ")}`);
    const fromRoot = await prisma.category.findUnique({ where: { slug: m.from }, select: { id: true } });
    const match = m.subcategory
      ? { subcategory: { equals: m.subcategory, mode: "insensitive" as const } }
      : { name: { equals: m.name!, mode: "insensitive" as const } };
    // every matching product in that root (a name can repeat), not just the first
    const all = fromRoot ? await prisma.catalogProduct.findMany({ where: { categoryId: fromRoot.id, ...match }, select: { id: true, categoryId: true, leafCategoryId: true, subcategory: true } }) : [];
    console.log(`move   ${m.subcategory ? `[${m.subcategory}]` : m.name} (${all.length}) → ${m.path.join(" > ")}`);
    if (APPLY && all.length) {
      undo.push(...all.map((x) => ({ id: x.id, categoryId: x.categoryId, leafCategoryId: x.leafCategoryId, subcategory: x.subcategory })));
      const root = idByPath.get(m.path[0]!)!;
      const isRoot = m.path.length === 1;
      await prisma.catalogProduct.updateMany({
        where: { id: { in: all.map((x) => x.id) } },
        data: { categoryId: root.id!, leafCategoryId: isRoot ? null : target.id, subcategory: isRoot ? null : target.name },
      });
      moved += all.length;
    }
  }

  for (const slug of tree.retireRoots ?? []) {
    const c = await prisma.category.findUnique({ where: { slug }, select: { id: true, _count: { select: { catalogProducts: true } } } });
    if (!c) continue;
    const left = c._count.catalogProducts;
    console.log(`retire root '${slug}'${left ? ` — SKIPPED, still has ${left} product(s)` : ""}`);
    if (APPLY && !left) await prisma.category.update({ where: { id: c.id }, data: { isActive: false, superCategoryId: null } });
  }

  // Roots that reuse an existing row (Root.slug) keep their OLD children from earlier backfills; once the products have been
  // moved, deactivate any that this tree did not write and that no product points at any more (never deletes).
  if (APPLY) {
    const reused = tree.roots.filter((r) => r.slug).map((r) => idByPath.get(r.n)!.id!);
    if (reused.length) {
      const everything = await prisma.category.findMany({ select: { id: true, parentId: true, name: true, isActive: true } });
      const rows = everything.map((c) => ({ id: c.id, parentId: c.parentId }));
      const stale = new Set(reused.flatMap((id) => subtreeIds(rows, id)).filter((id) => !touched.has(id)));
      for (const c of everything.filter((x) => stale.has(x.id) && x.isActive)) {
        const n = await prisma.catalogProduct.count({ where: { leafCategoryId: c.id } });
        console.log(`prune  '${c.name}'${n ? ` — SKIPPED, ${n} product(s) still on it` : ""}`);
        if (!n) await prisma.category.update({ where: { id: c.id }, data: { isActive: false } });
      }
    }
  }

  // Safety net for product moves: the previous category / leaf / subcategory of every product moved, so it can be reverted.
  if (APPLY && undo.length) {
    mkdirSync("scripts/undo", { recursive: true });
    const file = `scripts/undo/${treeName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify(undo));
    console.log(`undo file: ${file} (${undo.length} products' previous category, leaf and subcategory)`);
  }

  console.log(`\n${APPLY ? "Wrote" : "Would write"} ${nodes} category nodes (${withFields} with field templates) for '${treeName}'${APPLY ? `, moved ${moved} product(s)` : ""}.`);
  if (!APPLY) console.log("Dry run — re-run with --apply to write.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
