import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { istMidnight, computeUpcomingPlan } from "../services/subscriptionEngine.js";

// Seller-scoped subscription visibility. Mounted at /api/app/seller/subscriptions. A seller sees only
// the ACTIVE subscriptions against their OWN products (via variant.product.sellerId) — never the whole
// store's — plus a per-variant planning total for a target day (mirrors the owner's /upcoming, scoped).
// Read-only: sellers don't manage subscriptions directly (the customer does); this closes the visibility
// gap where subscription-generated orders otherwise just appear pre-packed with no forecast or context.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

const MS_DAY = 24 * 60 * 60 * 1000;

// A null CatalogProduct.sellerId is treated as the house seller everywhere in this codebase (products
// created via the owner's classic editor never set sellerId, only the seller-scoped editor does) — so a
// house co-manager must match BOTH their own sellerId and null, or they'd silently under-count.
function productFilterFor(req: SellerRequest) {
  return req.sellerIsHouse
    ? { OR: [{ sellerId: req.sellerId }, { sellerId: null }] }
    : { sellerId: req.sellerId };
}

// ─── GET /  — this seller's active subscriptions ─────────────────────
router.get("/", async (req: SellerRequest, res: Response) => {
  try {
    const subs = await prisma.subscription.findMany({
      where: { status: "ACTIVE", variant: { product: productFilterFor(req) } },
      orderBy: { createdAt: "desc" },
      include: { customer: { select: { name: true, phone: true } } },
    });
    res.json({
      success: true,
      data: subs.map((s) => ({
        ...s,
        quantity: Number(s.quantity),
        stepSize: s.stepSize == null ? null : Number(s.stepSize),
        customerName: s.customer?.name ?? null,
        customerPhone: s.customer?.phone ?? null,
      })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /upcoming?date=tomorrow|YYYY-MM-DD  — this seller's planning totals ─
// "Tomorrow: 12× Milk 500ml" — scoped to products this seller owns, so they can see what to prep
// without wading through the whole store's subscription volume.
router.get("/upcoming", async (req: SellerRequest, res: Response) => {
  try {
    const dateParam = (req.query.date as string | undefined) ?? "tomorrow";
    let target: Date;
    if (dateParam === "today") target = istMidnight(new Date());
    else if (dateParam === "tomorrow") target = istMidnight(new Date(Date.now() + MS_DAY));
    else {
      const parsed = new Date(dateParam);
      if (isNaN(parsed.getTime())) throw new ValidationError("Invalid date");
      target = istMidnight(parsed);
    }

    const items = await computeUpcomingPlan(target, req.sellerId, req.sellerIsHouse);
    res.json({ success: true, data: { date: target.toISOString(), items } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
