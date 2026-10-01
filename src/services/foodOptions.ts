import { z } from "zod";
import { ValidationError } from "../lib/errors.js";

// ─── Dish sizes, add-ons and customizations (FOOD_SELLER_PLAN.md F3) ─────────────────────────────
// Stored as three JSON columns on MenuItem rather than five relational tables: they are always read and
// written together with their dish, never queried across dishes, and each entry carries a stable id the
// order flow resolves against. ponytail: JSON columns, real tables if per-option reporting is ever needed.
//
// Pure — no Prisma — so the pricing rules are unit-testable like the rest of the food services.
//
// ⚠️ The client only ever sends IDS. Every price below is read from the stored dish, never from the
// request — the same rule priceOrder already enforces for the base price.

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(40).optional();

export const variantSchema = z.object({
  id,
  name: text(40),
  price: z.number().positive().max(100000),
});

export const addOnSchema = z.object({
  id,
  name: text(40),
  price: z.number().min(0).max(10000),
});

export const optionGroupSchema = z.object({
  id,
  name: text(40),
  required: z.boolean().default(false),
  /** 1 = pick one (spice level). More = pick up to that many (toppings). */
  maxChoices: z.number().int().min(1).max(10).default(1),
  options: z
    .array(z.object({ id, name: text(40), priceDelta: z.number().min(0).max(10000).default(0) }))
    .min(1)
    .max(12),
});

export const dishOptionsInput = {
  variants: z.array(variantSchema).max(6).optional(),
  addOns: z.array(addOnSchema).max(12).optional(),
  optionGroups: z.array(optionGroupSchema).max(6).optional(),
};

export type Variant = { id: string; name: string; price: number };
export type AddOn = { id: string; name: string; price: number };
export type OptionGroup = {
  id: string;
  name: string;
  required: boolean;
  maxChoices: number;
  options: { id: string; name: string; priceDelta: number }[];
};
export interface DishOptions {
  variants: Variant[];
  addOns: AddOn[];
  optionGroups: OptionGroup[];
}

/** Short random id for an entry that arrived without one. Collision-proofed against its own siblings below. */
function freshId(taken: Set<string>): string {
  let v: string;
  do {
    v = Math.random().toString(36).slice(2, 10);
  } while (taken.has(v));
  taken.add(v);
  return v;
}

/** Keeps an entry's id when it has a unique one, otherwise mints one — ids must be unique within a dish. */
function withIds<T extends { id?: string }>(rows: T[] | undefined): (T & { id: string })[] {
  const taken = new Set<string>();
  return (rows ?? []).map((r) => {
    if (r.id && !taken.has(r.id)) {
      taken.add(r.id);
      return { ...r, id: r.id };
    }
    return { ...r, id: freshId(taken) };
  });
}

/**
 * Validated seller input → the shape that is stored. Mints ids, and — when there are sizes — pins the
 * dish's own `price` to the FIRST size, so the menu's "from ₹140" and every old client that only reads
 * `price` stay truthful. Returns `price` only when it had to be overridden.
 */
export function normaliseDishOptions(input: {
  variants?: z.infer<typeof variantSchema>[];
  addOns?: z.infer<typeof addOnSchema>[];
  optionGroups?: z.infer<typeof optionGroupSchema>[];
}): { variants?: Variant[]; addOns?: AddOn[]; optionGroups?: OptionGroup[]; price?: number } {
  const out: ReturnType<typeof normaliseDishOptions> = {};
  if (input.variants) {
    out.variants = withIds(input.variants);
    if (out.variants.length > 0) out.price = out.variants[0].price;
  }
  if (input.addOns) out.addOns = withIds(input.addOns);
  if (input.optionGroups) {
    out.optionGroups = withIds(input.optionGroups).map((g) => ({
      ...g,
      // An option's id only has to be unique within the dish's OTHER options, since orders send a flat list.
      options: withIds(g.options),
      maxChoices: Math.min(g.maxChoices, g.options.length),
    }));
  }
  return out;
}

/** Reads the stored JSON defensively: a malformed column reads as "no options", never as a 500 on the menu. */
export function parseDishOptions(raw: { variants?: unknown; addOns?: unknown; optionGroups?: unknown }): DishOptions {
  const arr = <T>(schema: z.ZodType<T>, v: unknown): T[] => {
    const r = z.array(schema).safeParse(v ?? []);
    return r.success ? r.data : [];
  };
  return {
    variants: arr(z.object({ id: z.string(), name: z.string(), price: z.number() }), raw.variants),
    addOns: arr(z.object({ id: z.string(), name: z.string(), price: z.number() }), raw.addOns),
    optionGroups: arr(
      z.object({
        id: z.string(),
        name: z.string(),
        required: z.boolean(),
        maxChoices: z.number(),
        options: z.array(z.object({ id: z.string(), name: z.string(), priceDelta: z.number() })),
      }),
      raw.optionGroups,
    ),
  };
}

export interface DishSelection {
  variantId?: string | null;
  addOnIds?: string[];
  optionIds?: string[];
}

export interface ResolvedSelection {
  /** GST-inclusive price of ONE unit with everything chosen. */
  unitPrice: number;
  /**
   * What goes on the invoice line: the dish, its size, and every PRICED extra. Free customizations
   * ("Spice: Medium") don't belong on a tax invoice, so they live in [notes] only.
   */
  invoiceName: string;
  /** Human lines for the kitchen / order screens: "Size: Full", "+ Raita", "Spice level: Medium". */
  notes: string[];
}

/**
 * Prices one dish line from the stored dish and the customer's ids, enforcing the seller's rules.
 *
 * Throws a readable ValidationError (the customer sees it) for: a size missing / not on this dish, an
 * unknown add-on or option, a required group left empty, or too many picks in a group.
 */
export function resolveSelection(
  dish: { name: string; price: number } & DishOptions,
  sel: DishSelection,
): ResolvedSelection {
  let base = dish.price;
  let invoiceName = dish.name;
  const notes: string[] = [];

  if (dish.variants.length > 0) {
    const v = dish.variants.find((x) => x.id === sel.variantId);
    if (!v) throw new ValidationError(`Choose a size for ${dish.name}`);
    base = v.price;
    invoiceName += ` (${v.name})`;
    notes.push(`Size: ${v.name}`);
  } else if (sel.variantId) {
    throw new ValidationError(`${dish.name} has changed — please re-add it`);
  }

  const priced: string[] = [];
  let extras = 0;

  for (const aid of new Set(sel.addOnIds ?? [])) {
    const a = dish.addOns.find((x) => x.id === aid);
    if (!a) throw new ValidationError(`An add-on for ${dish.name} is no longer offered`);
    extras += a.price;
    priced.push(a.name);
    notes.push(`+ ${a.name}`);
  }

  const picked = new Set(sel.optionIds ?? []);
  const knownOptionIds = new Set(dish.optionGroups.flatMap((g) => g.options.map((o) => o.id)));
  for (const oid of picked) {
    if (!knownOptionIds.has(oid)) throw new ValidationError(`A choice for ${dish.name} is no longer offered`);
  }
  for (const g of dish.optionGroups) {
    const chosen = g.options.filter((o) => picked.has(o.id));
    if (g.required && chosen.length === 0) throw new ValidationError(`Choose ${g.name} for ${dish.name}`);
    if (chosen.length > g.maxChoices) {
      throw new ValidationError(`Pick at most ${g.maxChoices} for ${g.name} on ${dish.name}`);
    }
    for (const o of chosen) {
      extras += o.priceDelta;
      if (o.priceDelta > 0) priced.push(o.name);
      notes.push(`${g.name}: ${o.name}`);
    }
  }

  if (priced.length > 0) invoiceName += ` + ${priced.join(", ")}`;
  return { unitPrice: Math.round((base + extras) * 100) / 100, invoiceName, notes };
}
