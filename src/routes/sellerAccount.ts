import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";

// Seller-scoped profile + earnings. Mounted at /api/app/seller/me.
//   GET  /            → shop profile
//   PUT  /            → update editable profile fields (NOT commission/status — admin-controlled)
//   GET  /earnings    → gross / commission / net, outstanding balance, payout history
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

function shapeProfile(s: any) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    logoUrl: s.logoUrl,
    shopAddress: s.shopAddress,
    city: s.city,
    pincode: s.pincode,
    lat: s.lat != null ? Number(s.lat) : null,
    lng: s.lng != null ? Number(s.lng) : null,
    phone: s.phone,
    gstin: s.gstin,
    pan: s.pan,
    bankDetails: s.bankDetails ?? null,
    commissionPct: Number(s.commissionPct),
    outstandingBalance: Number(s.outstandingBalance),
    status: s.status,
    isActive: s.isActive,
  };
}

// ─── GET / — shop profile ─────────────────────────────────────────
router.get("/", async (req: SellerRequest, res: Response) => {
  try {
    const seller = await prisma.seller.findUnique({ where: { id: req.sellerId } });
    if (!seller) throw new NotFoundError("Seller", req.sellerId ?? "");
    res.json({ success: true, data: shapeProfile(seller) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PUT / — update editable profile fields ───────────────────────
const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  logoUrl: z.string().max(500).optional().nullable(),
  shopAddress: z.string().max(300).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  pincode: z.string().max(10).optional().nullable(),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
  phone: z.string().max(15).optional().nullable(),
  gstin: z.string().max(15).optional().nullable(),
  pan: z.string().max(10).optional().nullable(),
  bankDetails: z.any().optional().nullable(),
});

router.put("/", async (req: SellerRequest, res: Response) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid profile data", parsed.error.errors);
    const updated = await prisma.seller.update({ where: { id: req.sellerId }, data: parsed.data });
    res.json({ success: true, data: shapeProfile(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /earnings — gross / commission / net + payout history ────
router.get("/earnings", async (req: SellerRequest, res: Response) => {
  try {
    const seller = await prisma.seller.findUnique({
      where: { id: req.sellerId },
      select: { outstandingBalance: true, commissionPct: true },
    });
    if (!seller) throw new NotFoundError("Seller", req.sellerId ?? "");

    const [allTime, unsettled, payouts] = await Promise.all([
      prisma.subOrder.aggregate({ where: { sellerId: req.sellerId }, _sum: { subtotal: true, commissionAmount: true, netPayable: true }, _count: true }),
      prisma.subOrder.aggregate({ where: { sellerId: req.sellerId, settled: false }, _sum: { netPayable: true }, _count: true }),
      prisma.sellerPayout.findMany({ where: { sellerId: req.sellerId }, orderBy: { paidAt: "desc" }, take: 20 }),
    ]);

    res.json({
      success: true,
      data: {
        commissionPct: Number(seller.commissionPct),
        outstandingBalance: Number(seller.outstandingBalance),
        orderCount: allTime._count,
        totalGross: Number(allTime._sum.subtotal ?? 0),
        totalCommission: Number(allTime._sum.commissionAmount ?? 0),
        totalNet: Number(allTime._sum.netPayable ?? 0),
        unsettledCount: unsettled._count,
        unsettledNet: Number(unsettled._sum.netPayable ?? 0),
        payouts: payouts.map((p) => ({
          id: p.id,
          grossAmount: Number(p.grossAmount),
          commission: Number(p.commission),
          netPaid: Number(p.netPaid),
          paidAt: p.paidAt,
          mode: p.mode,
          reference: p.reference,
          note: p.note,
        })),
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
