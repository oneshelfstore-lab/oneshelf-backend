import { Router, type Response, type NextFunction } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { isTempUnavailable, nextIstOccurrence, normaliseFoodType } from "../services/foodMenu.js";
import { kitchenStats } from "../services/foodInsights.js";
import { dishOptionsInput, normaliseDishOptions, parseDishOptions } from "../services/foodOptions.js";

/**
 * Restaurant menu management. Mounted at /api/app/seller/menu (MULTIVERTICAL_PLAN.md §4.5).
 *
 * Every query is hard-filtered to the caller's own sellerId — a restaurant can never read or edit
 * another's menu. Same auth stack and same discipline as sellerCatalog.ts, which this mirrors.
 */
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

/**
 * ⚠️ Router-level, not per-route: a route added to this file later is gated by default rather than
 * being remembered about. A SHOP seller has no menu and must never be able to create one — the
 * grocery catalog is CatalogProduct, and letting the two mix is exactly what the separate-model
 * decision exists to prevent.
 */
function requireFoodSeller(req: SellerRequest, res: Response, next: NextFunction) {
  if (req.sellerVertical !== "FOOD") {
    return res.status(403).json({
      success: false,
      error: { code: "NOT_A_RESTAURANT", message: "This account is not a restaurant", details: [] },
    });
  }
  next();
}
router.use(requireFoodSeller as any);

const categorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});

/** "HH:MM" 24h, or absent/blank meaning "no window". Shared by both window fields. */
const hhMm = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM").optional().nullable(),
);

const itemSchema = z.object({
  menuCategoryId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  imageUrl: z.string().trim().max(500).optional().nullable(),
  price: z.number().positive().max(100000),
  // New clients send foodType; an older build sends only isVeg. normaliseFoodType() reconciles the two.
  foodType: z.enum(["VEG", "EGG", "NON_VEG"]).optional(),
  isVeg: z.boolean().optional(),
  isBestseller: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
  isActive: z.boolean().optional(),
  prepMinutes: z.number().int().min(1).max(240).optional(),
  // ⚠️ GST/CA: both of these are unverified defaults until the Sec 9(5) position is confirmed.
  sacCode: z.string().trim().max(8).optional().nullable(),
  gstRate: z.number().min(0).max(28).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  // Serving window, "HH:MM" 24h IST. ⚠️ "" normalises to null (= no window) so clearing one half
  // of a partially-filled form CLEARS it instead of 400-ing — the app sends both fields every save.
  availableFrom: hhMm,
  availableTo: hhMm,
  // Sizes / add-ons / customizations (F3). Sent whole on every save; omitted = left alone, [] = cleared.
  ...dishOptionsInput,
});

/** Paper trail for money-affecting menu changes (price, availability). Best-effort — never fails the edit. */
function audit(req: SellerRequest, entityId: string, oldValues: object, newValues: object) {
  prisma.auditLog
    .create({ data: { userId: req.appUser!.id, action: "UPDATE", entityType: "MenuItem", entityId, oldValues: oldValues as any, newValues: newValues as any } })
    .catch((e: unknown) => console.warn("menu audit write failed (non-fatal):", e));
}

/** Splits the option lists off, normalises them (ids, price pinned to the first size) and food type, ready for Prisma. */
function prepareItemData(d: any): any {
  const { variants, addOns, optionGroups, ...rest } = d;
  return { ...normaliseFoodType(rest), ...normaliseDishOptions({ variants, addOns, optionGroups }) };
}

function shapeItem(i: any) {
  const opts = parseDishOptions(i);
  return {
    id: i.id,
    menuCategoryId: i.menuCategoryId,
    name: i.name,
    description: i.description,
    imageUrl: i.imageUrl,
    price: Number(i.price),
    isVeg: i.isVeg,
    foodType: i.foodType,
    isBestseller: i.isBestseller,
    isAvailable: i.isAvailable,
    // Only while the timer is still running — a past value is sent as null so the app just asks "non-null?".
    unavailableUntil: isTempUnavailable(i.unavailableUntil) ? i.unavailableUntil.toISOString() : null,
    variants: opts.variants,
    addOns: opts.addOns,
    optionGroups: opts.optionGroups,
    isActive: i.isActive,
    prepMinutes: i.prepMinutes,
    availableFrom: i.availableFrom,
    availableTo: i.availableTo,
    sacCode: i.sacCode,
    gstRate: Number(i.gstRate),
    sortOrder: i.sortOrder,
  };
}

/**
 * The seller's whole menu, INCLUDING inactive categories/items — this is the editor, so a
 * soft-deleted row has to stay visible to be restorable. The customer-facing read
 * (routes/food.ts) is the one that filters.
 */
router.get("/", async (req: SellerRequest, res: Response) => {
  try {
    const categories = await prisma.menuCategory.findMany({
      where: { sellerId: req.sellerId! },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    });
    res.json({
      success: true,
      data: categories.map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sortOrder,
        isActive: c.isActive,
        items: c.items.map(shapeItem),
      })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Categories ─────────────────────────────────────────────────────────────────────────────────

router.post("/categories", async (req: SellerRequest, res: Response) => {
  try {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid category");
    const created = await prisma.menuCategory.create({
      data: { ...parsed.data, sellerId: req.sellerId! },
    });
    res.json({ success: true, data: { id: created.id } });
  } catch (e) {
    sendError(res, e);
  }
});

/** Sets the customer-facing section order: ids in the order wanted. Foreign ids simply match no row. */
router.put("/categories/reorder", async (req: SellerRequest, res: Response) => {
  try {
    const parsed = z.object({ ids: z.array(z.string().min(1)).min(1).max(100) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid order");
    await prisma.$transaction(
      parsed.data.ids.map((id, i) =>
        prisma.menuCategory.updateMany({ where: { id, sellerId: req.sellerId! }, data: { sortOrder: i } }),
      ),
    );
    res.json({ success: true, data: { count: parsed.data.ids.length } });
  } catch (e) {
    sendError(res, e);
  }
});

router.put("/categories/:id", async (req: SellerRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = categorySchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid category");
    // updateMany + the sellerId filter, so another seller's id can only ever match 0 rows —
    // never a 200 that silently edited someone else's menu.
    const r = await prisma.menuCategory.updateMany({
      where: { id, sellerId: req.sellerId! },
      data: parsed.data,
    });
    if (r.count === 0) throw new NotFoundError("Menu category", id);
    res.json({ success: true, data: { id } });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * Soft delete. ⚠️ A hard delete would CASCADE every MenuItem under it out of existence — and while
 * OrderItem.menuItemId is SetNull (so order history survives on its name snapshot), the seller
 * would have silently lost a whole section with no undo.
 */
router.delete("/categories/:id", async (req: SellerRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const r = await prisma.menuCategory.updateMany({
      where: { id, sellerId: req.sellerId! },
      data: { isActive: false },
    });
    if (r.count === 0) throw new NotFoundError("Menu category", id);
    res.json({ success: true, data: { id } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Items ──────────────────────────────────────────────────────────────────────────────────────

router.post("/items", async (req: SellerRequest, res: Response) => {
  try {
    const parsed = itemSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid menu item");
    // The category must be one of THIS seller's, or an item could be parented into another
    // restaurant's menu section.
    const cat = await prisma.menuCategory.findFirst({
      where: { id: parsed.data.menuCategoryId, sellerId: req.sellerId! },
      select: { id: true },
    });
    if (!cat) throw new ValidationError("Unknown menu category");

    const created = await prisma.menuItem.create({
      data: { ...prepareItemData(parsed.data), sellerId: req.sellerId! },
    });
    res.json({ success: true, data: shapeItem(created) });
  } catch (e) {
    sendError(res, e);
  }
});

router.put("/items/:id", async (req: SellerRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = itemSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid menu item");
    if (parsed.data.menuCategoryId) {
      const cat = await prisma.menuCategory.findFirst({
        where: { id: parsed.data.menuCategoryId, sellerId: req.sellerId! },
        select: { id: true },
      });
      if (!cat) throw new ValidationError("Unknown menu category");
    }
    const before = parsed.data.price !== undefined
      ? await prisma.menuItem.findFirst({ where: { id, sellerId: req.sellerId! }, select: { price: true } })
      : null;
    const r = await prisma.menuItem.updateMany({
      where: { id, sellerId: req.sellerId! },
      data: prepareItemData(parsed.data),
    });
    if (r.count === 0) throw new NotFoundError("Menu item", id);
    if (before && Number(before.price) !== parsed.data.price) {
      audit(req, id, { price: Number(before.price) }, { price: parsed.data.price });
    }
    res.json({ success: true, data: { id } });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * "86 it" — sold out for today, back tomorrow. Its own one-field route because this is the single
 * most-used action in a restaurant's day and must be one tap, not a full item save.
 *
 * ⚠️ Deliberately distinct from isActive (removed from the menu entirely). Conflating them means a
 * dish that ran out at lunch quietly vanishes from the menu forever.
 */
const availabilitySchema = z.object({
  isAvailable: z.boolean(),
  // A TIMED 86 — only meaningful with isAvailable:false. 30 min, 1 h … or untilClosing. Neither = off
  // until the seller switches it back on. The client sends a choice, never a timestamp (server clock).
  minutes: z.number().int().min(5).max(1440).optional(),
  untilClosing: z.boolean().optional(),
});
router.patch("/items/:id/availability", async (req: SellerRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = availabilitySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("isAvailable is required");
    const { isAvailable, minutes, untilClosing } = parsed.data;

    let unavailableUntil: Date | null = null;
    if (!isAvailable && minutes) {
      unavailableUntil = new Date(Date.now() + minutes * 60_000);
    } else if (!isAvailable && untilClosing) {
      const s = await prisma.seller.findUnique({ where: { id: req.sellerId! }, select: { closeTime: true } });
      unavailableUntil = nextIstOccurrence(s?.closeTime);
    }
    // A timed 86 leaves isAvailable TRUE — the dish comes back by itself when the timer runs out. A plain
    // "off" sets it false (back only when switched on). Switching ON clears both.
    const timed = unavailableUntil != null;
    const r = await prisma.menuItem.updateMany({
      where: { id, sellerId: req.sellerId! },
      data: { isAvailable: timed ? true : isAvailable, unavailableUntil },
    });
    if (r.count === 0) throw new NotFoundError("Menu item", id);
    audit(req, id, {}, { isAvailable, unavailableUntil: unavailableUntil?.toISOString() ?? null });
    res.json({
      success: true,
      data: { id, isAvailable, unavailableUntil: unavailableUntil ? unavailableUntil.toISOString() : null },
    });
  } catch (e) {
    sendError(res, e);
  }
});

router.delete("/items/:id", async (req: SellerRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const r = await prisma.menuItem.updateMany({
      where: { id, sellerId: req.sellerId! },
      data: { isActive: false },
    });
    if (r.count === 0) throw new NotFoundError("Menu item", id);
    res.json({ success: true, data: { id } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /insights — how the kitchen is doing (F4) ───────────────────────────────────────────────
// Top dishes, peak order times, cancellation rate and average prep time. Everything is derived from this
// restaurant's own orders; nothing is estimated. Hard-filtered to req.sellerId like every other route here.
router.get("/insights", async (req: SellerRequest, res: Response) => {
  try {
    const range = z.enum(["today", "week", "month"]).catch("week").parse(req.query.range);
    const days = range === "today" ? 1 : range === "week" ? 7 : 30;
    // IST midnight today: the next IST midnight, minus a day. "7 days" means today + the 6 before it.
    const todayStart = new Date(nextIstOccurrence(null).getTime() - 24 * 3600_000);
    const since = new Date(todayStart.getTime() - (days - 1) * 24 * 3600_000);
    // An unpaid online order never reached the kitchen, so it is not an order here either.
    const unpaid = { paymentMethod: { in: ["ONLINE", "UPI"] }, paymentStatus: "PENDING" };

    const subs = await prisma.subOrder.findMany({
      where: { sellerId: req.sellerId!, createdAt: { gte: since }, order: { is: { NOT: unpaid } } } as any,
      select: { id: true, status: true, createdAt: true },
      take: 3000,
    });
    const events = subs.length
      ? await prisma.orderEvent.findMany({
          where: { subOrderId: { in: subs.map((s) => s.id) }, toState: { in: ["ACCEPTED", "PACKED"] } },
          select: { subOrderId: true, toState: true, createdAt: true },
        })
      : [];

    const grouped = await prisma.orderItem.groupBy({
      by: ["menuItemId"],
      where: {
        sellerId: req.sellerId!, menuItemId: { not: null },
        order: { createdAt: { gte: since }, status: { not: "CANCELLED" }, NOT: unpaid },
      } as any,
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 5,
    });
    const names = await prisma.menuItem.findMany({
      where: { id: { in: grouped.map((g) => g.menuItemId!).filter(Boolean) }, sellerId: req.sellerId! },
      select: { id: true, name: true, imageUrl: true },
    });
    const byId = new Map(names.map((n) => [n.id, n]));

    res.json({
      success: true,
      data: {
        range,
        ...kitchenStats(subs, events),
        topDishes: grouped.map((g) => ({
          id: g.menuItemId,
          name: byId.get(g.menuItemId!)?.name ?? "Removed dish",
          imageUrl: byId.get(g.menuItemId!)?.imageUrl ?? null,
          quantity: Number(g._sum.quantity ?? 0),
          revenue: Number(g._sum.lineTotal ?? 0),
        })),
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
