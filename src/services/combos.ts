import { z } from "zod";
import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";
import { formatProductForApp } from "../routes/catalog.js";
import { memoCache } from "../lib/httpCache.js";

// ═══════════════════════════════════════════════════════════════════════
// Combo = owner-curated bundle (checklist). See schema.prisma's Combo doc.
// Shared by ownerCombos.ts (owner) and sellerCombos.ts (house co-manager),
// same as free-gifts — one service, two auth stacks, never drift.
// ═══════════════════════════════════════════════════════════════════════

export const comboItemSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().min(1).max(999).default(1),
});

export const comboSchema = z.object({
  name: z.string().min(1).max(120),
  nameHi: z.string().max(120).optional().nullable(),
  imageUrl: z.string().url().optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  isActive: z.boolean().default(true),
  activeFrom: z.string().datetime().optional().nullable(),
  activeUntil: z.string().datetime().optional().nullable(),
  displayOrder: z.number().int().min(0).default(0),
  items: z.array(comboItemSchema).min(1).max(50),
});

// Admin manager shape — combo row + lightweight item info for editing.
const adminInclude = {
  items: {
    include: {
      variant: { select: { id: true, sku: true, packageSize: true, packageUnit: true, product: { select: { name: true, imageUrls: true } } } },
    },
  },
} as const;

// Every item variant must belong to the HOUSE catalog (null sellerId ⇒ legacy = house, same as
// free-gifts). Giving away / bundling a third-party seller's product has no payout story in v1.
async function validateHouseVariants(variantIds: string[]): Promise<void> {
  const uniq = [...new Set(variantIds)];
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: uniq } },
    select: { id: true, product: { select: { sellerId: true, seller: { select: { isHouse: true } } } } },
  });
  if (variants.length !== uniq.length) throw new ValidationError("One or more products in this combo no longer exist.");
  const nonHouse = variants.find((v) => !(v.product.sellerId == null || v.product.seller?.isHouse === true));
  if (nonHouse) throw new ValidationError("Combos only work with the store's own (house) products for now.");
}

export function listCombos() {
  return prisma.combo.findMany({ include: adminInclude, orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }] });
}

export async function createComboRecord(data: z.infer<typeof comboSchema>) {
  await validateHouseVariants(data.items.map((i) => i.variantId));
  const combo = await prisma.combo.create({
    data: {
      name: data.name,
      nameHi: data.nameHi ?? null,
      imageUrl: data.imageUrl ?? null,
      description: data.description ?? null,
      isActive: data.isActive,
      activeFrom: data.activeFrom ? new Date(data.activeFrom) : null,
      activeUntil: data.activeUntil ? new Date(data.activeUntil) : null,
      displayOrder: data.displayOrder,
      items: { create: data.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) },
    },
    include: adminInclude,
  });
  memoCache.bust("combos");
  return combo;
}

export async function updateComboRecord(id: string, data: z.infer<typeof comboSchema>) {
  const existing = await prisma.combo.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Combo", id);
  await validateHouseVariants(data.items.map((i) => i.variantId));
  // Items are a curated list — simplest correct update is replace-all (no per-row diffing needed;
  // ComboItem carries no history/FK worth preserving).
  const combo = await prisma.$transaction(async (tx) => {
    await tx.comboItem.deleteMany({ where: { comboId: id } });
    return tx.combo.update({
      where: { id },
      data: {
        name: data.name,
        nameHi: data.nameHi ?? null,
        imageUrl: data.imageUrl ?? null,
        description: data.description ?? null,
        isActive: data.isActive,
        activeFrom: data.activeFrom ? new Date(data.activeFrom) : null,
        activeUntil: data.activeUntil ? new Date(data.activeUntil) : null,
        displayOrder: data.displayOrder,
        items: { create: data.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) },
      },
      include: adminInclude,
    });
  });
  memoCache.bust("combos");
  return combo;
}

export async function deleteComboRecord(id: string): Promise<void> {
  const existing = await prisma.combo.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Combo", id);
  await prisma.combo.delete({ where: { id } }); // items cascade
  memoCache.bust("combos");
}

/**
 * Customer-facing: active combos within their occasion window, each item hydrated with the full
 * formatted product (so the app parses combo item products exactly like any other product — the
 * checklist picks the target variant out of product.variants by variantId). Memoized 60s,
 * bust-on-write from the admin CRUD.
 */
export async function getPublicCombos() {
  return memoCache.get("combos:public", 60_000, async () => {
    const now = new Date();
    const combos = await prisma.combo.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ activeFrom: null }, { activeFrom: { lte: now } }] },
          { OR: [{ activeUntil: null }, { activeUntil: { gte: now } }] },
        ],
      },
      include: { items: { select: { id: true, variantId: true, quantity: true } } },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
    });
    if (combos.length === 0) return [];

    // One batched product fetch for every variant across all combos.
    const variantIds = [...new Set(combos.flatMap((c) => c.items.map((i) => i.variantId)))];
    const products = await prisma.catalogProduct.findMany({
      where: { variants: { some: { id: { in: variantIds } } } },
      include: {
        variants: { where: { isActive: true }, orderBy: { packageSize: "asc" } },
        category: { select: { slug: true, name: true } },
        seller: { select: { id: true, name: true, isHouse: true, grievanceOfficerName: true, grievanceOfficerPhone: true } },
      },
    });
    const productByVariant = new Map<string, any>();
    for (const p of products) for (const v of p.variants) productByVariant.set(v.id, p);

    return combos.map((c) => ({
      id: c.id,
      name: c.name,
      nameHi: c.nameHi,
      imageUrl: c.imageUrl,
      description: c.description,
      activeFrom: c.activeFrom,
      activeUntil: c.activeUntil,
      items: c.items
        .filter((i) => productByVariant.has(i.variantId))
        .map((i) => ({
          id: i.id,
          variantId: i.variantId,
          quantity: i.quantity,
          product: formatProductForApp(productByVariant.get(i.variantId)),
        })),
    }));
  });
}
