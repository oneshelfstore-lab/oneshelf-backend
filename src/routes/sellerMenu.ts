import { Router, type Response, type NextFunction } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";

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

const itemSchema = z.object({
  menuCategoryId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  imageUrl: z.string().trim().max(500).optional().nullable(),
  price: z.number().positive().max(100000),
  isVeg: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
  isActive: z.boolean().optional(),
  prepMinutes: z.number().int().min(1).max(240).optional(),
  // ⚠️ GST/CA: both of these are unverified defaults until the Sec 9(5) position is confirmed.
  sacCode: z.string().trim().max(8).optional().nullable(),
  gstRate: z.number().min(0).max(28).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

function shapeItem(i: any) {
  return {
    id: i.id,
    menuCategoryId: i.menuCategoryId,
    name: i.name,
    description: i.description,
    imageUrl: i.imageUrl,
    price: Number(i.price),
    isVeg: i.isVeg,
    isAvailable: i.isAvailable,
    isActive: i.isActive,
    prepMinutes: i.prepMinutes,
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
      data: { ...parsed.data, sellerId: req.sellerId! },
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
    const r = await prisma.menuItem.updateMany({
      where: { id, sellerId: req.sellerId! },
      data: parsed.data,
    });
    if (r.count === 0) throw new NotFoundError("Menu item", id);
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
router.patch("/items/:id/availability", async (req: SellerRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = z.object({ isAvailable: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("isAvailable is required");
    const r = await prisma.menuItem.updateMany({
      where: { id, sellerId: req.sellerId! },
      data: { isAvailable: parsed.data.isAvailable },
    });
    if (r.count === 0) throw new NotFoundError("Menu item", id);
    res.json({ success: true, data: { id, isAvailable: parsed.data.isAvailable } });
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

export default router;
