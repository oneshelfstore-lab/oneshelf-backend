import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";
import { requireRole } from "../middleware/auth.js";
import {
  firebaseAuthMiddleware,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// ═══════════════════════════════════════════════════════════════════════
// Public router (Firebase auth, mounted at /api/app/coupons)
// ═══════════════════════════════════════════════════════════════════════

export const appCouponRouter = Router();

appCouponRouter.use(firebaseAuthMiddleware as any);

// POST /api/app/coupons/validate — preview coupon without applying.
// NOTE: cartTotal here is client-supplied and used ONLY for this preview. The
// authoritative discount is recomputed server-side from the DB cart in
// calculateCartTotals() at order placement, so a tampered cartTotal cannot
// affect the real order — it only changes the previewed number.
const validateSchema = z.object({
  code: z.string().min(1).max(20),
  cartTotal: z.number().min(0),
});

appCouponRouter.post("/validate", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = validateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);

    const { code, cartTotal } = parsed.data;
    const coupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });

    if (!coupon) {
      return res.json({ success: true, data: { valid: false, reason: "Coupon not found" } });
    }
    if (!coupon.isActive) {
      return res.json({ success: true, data: { valid: false, reason: "Coupon is inactive" } });
    }

    const now = new Date();
    if (coupon.validFrom && coupon.validFrom > now) {
      return res.json({ success: true, data: { valid: false, reason: "Coupon is not yet active" } });
    }
    if (coupon.validUntil && coupon.validUntil < now) {
      return res.json({ success: true, data: { valid: false, reason: "Coupon has expired" } });
    }
    if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
      return res.json({ success: true, data: { valid: false, reason: "Coupon usage limit reached" } });
    }
    if (coupon.perUserLimit) {
      const usedByUser = await prisma.couponRedemption.count({
        where: { couponId: coupon.id, userId: req.appUser!.id },
      });
      if (usedByUser >= coupon.perUserLimit) {
        return res.json({ success: true, data: { valid: false, reason: "You've already used this coupon" } });
      }
    }
    if (cartTotal < Number(coupon.minOrder)) {
      return res.json({
        success: true,
        data: { valid: false, reason: `Minimum order ₹${coupon.minOrder} required` },
      });
    }

    let discount = 0;
    if (coupon.couponType === "PERCENT") {
      discount = Math.round(cartTotal * Number(coupon.value) / 100 * 100) / 100;
      if (coupon.maxDiscount) discount = Math.min(discount, Number(coupon.maxDiscount));
    } else if (coupon.couponType === "FLAT") {
      discount = Math.min(Number(coupon.value), cartTotal);
    } else if (coupon.couponType === "FREE_DELIVERY") {
      discount = 0; // Delivery charge waiver, not a price discount
    }

    res.json({
      success: true,
      data: {
        valid: true,
        code: coupon.code,
        type: coupon.couponType,
        discount,
        description: coupon.description,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/coupons/available — visible coupons for customers
appCouponRouter.get("/available", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const now = new Date();
    const coupons = await prisma.coupon.findMany({
      where: {
        isActive: true,
        OR: [
          { validFrom: null, validUntil: null },
          { validFrom: { lte: now }, validUntil: null },
          { validFrom: null, validUntil: { gte: now } },
          { validFrom: { lte: now }, validUntil: { gte: now } },
        ],
      },
      select: {
        code: true, couponType: true, value: true, minOrder: true,
        maxDiscount: true, description: true, validUntil: true,
      },
      orderBy: { code: "asc" },
    });

    res.json({ success: true, data: coupons });
  } catch (e) {
    sendError(res, e);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Admin router (JWT auth, mounted at /api/coupons behind authMiddleware)
// ═══════════════════════════════════════════════════════════════════════

export const adminCouponRouter = Router();

const CouponTypeEnum = z.enum(["PERCENT", "FLAT", "FREE_DELIVERY"]);

const couponSchema = z.object({
  code: z.string().min(1).max(20).transform(s => s.toUpperCase()),
  couponType: CouponTypeEnum,
  value: z.number().min(0),
  minOrder: z.number().min(0).default(0),
  maxDiscount: z.number().positive().optional().nullable(),
  isActive: z.boolean().default(true),
  validFrom: z.coerce.date().optional().nullable(),
  validUntil: z.coerce.date().optional().nullable(),
  usageLimit: z.number().int().positive().optional().nullable(),
  perUserLimit: z.number().int().positive().optional().nullable(),
  description: z.string().max(200).optional().nullable(),
});

// GET /api/coupons — list all
adminCouponRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const coupons = await prisma.coupon.findMany({ orderBy: { code: "asc" }, take: 500 });
    res.json({ success: true, data: coupons });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/coupons — create
adminCouponRouter.post("/", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const parsed = couponSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid coupon data", parsed.error.errors);

    const existing = await prisma.coupon.findUnique({ where: { code: parsed.data.code } });
    if (existing) throw new ConflictError(`Coupon '${parsed.data.code}' already exists`);

    const coupon = await prisma.coupon.create({ data: parsed.data });
    res.status(201).json({ success: true, data: coupon });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /api/coupons/:id — update
adminCouponRouter.put("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Coupon", req.params.id!);

    const parsed = couponSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid coupon data", parsed.error.errors);

    if (parsed.data.code && parsed.data.code !== existing.code) {
      const dup = await prisma.coupon.findUnique({ where: { code: parsed.data.code } });
      if (dup) throw new ConflictError(`Coupon '${parsed.data.code}' already exists`);
    }

    const coupon = await prisma.coupon.update({ where: { id: req.params.id }, data: parsed.data });
    res.json({ success: true, data: coupon });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /api/coupons/:id — deactivate
adminCouponRouter.delete("/:id", requireRole("OWNER") as any, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Coupon", req.params.id!);

    await prisma.coupon.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ success: true, message: "Coupon deactivated" });
  } catch (e) {
    sendError(res, e);
  }
});
