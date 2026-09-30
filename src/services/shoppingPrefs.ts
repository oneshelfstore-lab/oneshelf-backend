import { z } from "zod";
import prisma from "../lib/prisma.js";

// Customer shopping preferences: which services they use and which categories they care about.
// One nullable JSON column on User — NULL means "never asked", which the app uses to decide whether
// to nudge; an empty-arrays object means "asked, and chose nothing". Those must stay distinct.
//
// ⚠️ PREF_SERVICES are wire values, the same names as the app's Vertical enum (SHOP/COURIER/FOOD).
// Add entries, never rename — a renamed value orphans every saved preference silently.
export const PREF_SERVICES = ["SHOP", "FOOD", "COURIER"] as const;

// A type alias, not an interface: Prisma's Json input needs the implicit index signature.
export type ShoppingPrefs = {
  services: string[];
  categories: string[]; // Category slugs
};

const uniq = <T,>(a: T[]) => [...new Set(a)];

export const shoppingPrefsSchema = z.object({
  services: z.array(z.enum(PREF_SERVICES)).max(PREF_SERVICES.length).transform(uniq),
  categories: z.array(z.string().trim().min(1).max(80)).max(30).transform(uniq),
});

/** Tolerant read of the stored JSON: anything malformed reads as "never set" rather than throwing. */
export function readShoppingPrefs(raw: unknown): ShoppingPrefs | null {
  if (raw == null) return null;
  const p = shoppingPrefsSchema.safeParse(raw);
  return p.success ? p.data : null;
}

/** Drops slugs of categories that no longer exist (owner deleted/renamed one after the customer chose it). */
async function onlyLiveCategories(slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return slugs;
  const live = await prisma.category.findMany({ where: { slug: { in: slugs } }, select: { slug: true } });
  const ok = new Set(live.map((c) => c.slug));
  return slugs.filter((s) => ok.has(s));
}

export async function getShoppingPrefs(userId: string): Promise<ShoppingPrefs & { isSet: boolean }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { shoppingPrefs: true } });
  const p = readShoppingPrefs(u?.shoppingPrefs);
  if (!p) return { isSet: false, services: [], categories: [] };
  return { isSet: true, services: p.services, categories: await onlyLiveCategories(p.categories) };
}

export async function saveShoppingPrefs(userId: string, input: ShoppingPrefs) {
  const clean: ShoppingPrefs = { services: input.services, categories: await onlyLiveCategories(input.categories) };
  await prisma.user.update({ where: { id: userId }, data: { shoppingPrefs: clean } });
  return { isSet: true, ...clean };
}
