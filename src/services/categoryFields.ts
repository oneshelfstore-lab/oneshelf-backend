// Category-driven product fields. A category node stores `fieldSchema` (what it ADDS); a product's form is
// the union down its path root → leaf, so "Tip size" is defined once on Pens and applies to every pen type.
// Values live on CatalogProduct.attributes as { key: string } (booleans as "true"/"false") so the apps
// need no polymorphic JSON handling.

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ValidationError } from "../lib/errors.js";
import { MAX_DEPTH } from "./categoryTree.js";

export const fieldDefSchema = z.object({
  key: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/, "key must be lowercase letters, digits, underscores"),
  label: z.string().min(1).max(60),
  type: z.enum(["TEXT", "NUMBER", "CHOICE", "BOOLEAN"]),
  options: z.array(z.string().min(1).max(40)).max(40).optional(),
  unit: z.string().max(12).optional(),
  required: z.boolean().optional(),
  filterable: z.boolean().optional(),
  showOnCard: z.boolean().optional(),
});
export type FieldDef = z.infer<typeof fieldDefSchema>;

export const fieldSchemaSchema = z.array(fieldDefSchema).max(20).superRefine((fields, ctx) => {
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.key)) ctx.addIssue({ code: "custom", message: `duplicate field key '${f.key}'` });
    seen.add(f.key);
    if (f.type === "CHOICE" && !f.options?.length) ctx.addIssue({ code: "custom", message: `'${f.key}' is a CHOICE field and needs options` });
  }
});

type Db = Pick<Prisma.TransactionClient, "category">;

/** Fields for a category node: ancestors' fields first, a descendant redefining a key replaces it in place. */
export async function fieldsForCategory(db: Db, categoryId: string): Promise<FieldDef[]> {
  const chain: unknown[] = [];
  const seen = new Set<string>();
  for (let id: string | null = categoryId; id && !seen.has(id) && chain.length < MAX_DEPTH + 2; ) {
    seen.add(id);
    const row: { parentId: string | null; fieldSchema: unknown } | null = await db.category.findUnique({
      where: { id }, select: { parentId: true, fieldSchema: true },
    });
    if (!row) break;
    chain.unshift(row.fieldSchema);
    id = row.parentId;
  }
  const byKey = new Map<string, FieldDef>();
  for (const raw of chain) {
    const parsed = fieldSchemaSchema.safeParse(raw ?? []);
    if (parsed.success) for (const f of parsed.data) byKey.set(f.key, f);
  }
  return [...byKey.values()];
}

/**
 * Validate a seller's submitted values against the category's fields. Unknown keys are dropped (a category
 * change leaves stale keys behind), blanks are dropped, and a missing required field throws.
 */
export function cleanAttributes(fields: FieldDef[], raw: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const problems: string[] = [];
  for (const f of fields) {
    const v = (raw?.[f.key] ?? "").toString().trim();
    if (!v) {
      if (f.required) problems.push(`${f.label} is required`);
      continue;
    }
    if (f.type === "NUMBER" && !Number.isFinite(Number(v))) problems.push(`${f.label} must be a number`);
    else if (f.type === "CHOICE" && !f.options?.includes(v)) problems.push(`${f.label}: '${v}' is not one of the options`);
    else if (f.type === "BOOLEAN" && v !== "true" && v !== "false") problems.push(`${f.label} must be yes or no`);
    else out[f.key] = v.slice(0, 100);
  }
  if (problems.length) throw new ValidationError(problems.join("; "));
  return out;
}

/** Display rows for the product page: filled fields in schema order, units appended, booleans as Yes/No. */
export function specsFor(fields: FieldDef[], attrs: unknown): { label: string; value: string }[] {
  const a = (attrs && typeof attrs === "object" ? attrs : {}) as Record<string, string>;
  return fields.flatMap((f) => {
    const v = a[f.key];
    if (!v) return [];
    const value = f.type === "BOOLEAN" ? (v === "true" ? "Yes" : "No") : f.unit ? `${v} ${f.unit}` : v;
    return [{ label: f.label, value }];
  });
}

export type FormNode = { id: string; name: string; fields: FieldDef[]; types?: FormNode[] };
export type CategoryForm = { rootId: string; fields: FieldDef[]; children: FormNode[] };
type FormRow = { id: string; name: string; parentId: string | null; displayOrder: number; fieldSchema: unknown };

/**
 * Everything an add-product form needs for one top-level category in a single payload: each sub-category
 * (and its "type" grandchildren) with its FULL inherited field list, so the apps do no tree walking.
 */
export function buildCategoryForm(rows: FormRow[], rootId: string): CategoryForm {
  const own = (r: FormRow): FieldDef[] => {
    const p = fieldSchemaSchema.safeParse(r.fieldSchema ?? []);
    return p.success ? p.data : [];
  };
  const merge = (base: FieldDef[], add: FieldDef[]): FieldDef[] => {
    const byKey = new Map(base.map((f) => [f.key, f]));
    for (const f of add) byKey.set(f.key, f);
    return [...byKey.values()];
  };
  const kids = (id: string) => rows.filter((r) => r.parentId === id).sort((a, b) => a.displayOrder - b.displayOrder);
  const make = (r: FormRow, inherited: FieldDef[], depth: number): FormNode => {
    const fields = merge(inherited, own(r));
    const types = depth < 2 ? kids(r.id).map((k) => make(k, fields, depth + 1)) : [];
    return { id: r.id, name: r.name, fields, ...(types.length ? { types } : {}) };
  };
  const root = rows.find((r) => r.id === rootId);
  const rootFields = root ? own(root) : [];
  return { rootId, fields: rootFields, children: kids(rootId).map((k) => make(k, rootFields, 1)) };
}
