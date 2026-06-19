import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// Owner-managed marketplace sellers. Mounted at /api/app/owner/sellers (Firebase auth + OWNER).
// Onboard a seller BY PHONE (no UIDs): promote an existing user to SELLER + link, or pre-create a
// SELLER row that firebaseAuth links on first login (keeps the role). Approve/suspend + set commission.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

function normalizePhone(input: string): string {
  return input.replace(/\D/g, "").slice(-10);
}

function slugify(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return base || "seller";
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (await prisma.seller.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

function shape(s: any) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    logoUrl: s.logoUrl,
    phone: s.phone,
    status: s.status,
    isHouse: s.isHouse,
    isActive: s.isActive,
    commissionPct: Number(s.commissionPct),
    outstandingBalance: Number(s.outstandingBalance),
    gstin: s.gstin,
    city: s.city,
    productCount: s._count?.products ?? 0,
    ownerUserId: s.ownerUserId,
    ownerName: s.ownerUser?.name ?? null,
    // true once the seller's login has actually been used (Firebase account linked).
    ownerActive: s.ownerUser ? !!s.ownerUser.firebaseUid : false,
    createdAt: s.createdAt,
  };
}

const INCLUDE = {
  _count: { select: { products: true } },
  ownerUser: { select: { name: true, firebaseUid: true } },
} as const;

// GET / — list sellers (house first, then newest), with product counts.
router.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const sellers = await prisma.seller.findMany({
      orderBy: [{ isHouse: "desc" }, { createdAt: "desc" }],
      include: INCLUDE,
    });
    res.json({ success: true, data: sellers.map(shape) });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /:id — seller detail + unsettled sub-order summary (what the platform currently owes).
router.get("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const seller = await prisma.seller.findUnique({
      where: { id },
      include: {
        _count: { select: { products: true } },
        ownerUser: { select: { name: true, phone: true, firebaseUid: true } },
      },
    });
    if (!seller) throw new NotFoundError("Seller", id);

    const unsettled = await prisma.subOrder.aggregate({
      where: { sellerId: id, settled: false },
      _sum: { netPayable: true, subtotal: true, commissionAmount: true },
      _count: true,
    });

    res.json({
      success: true,
      data: {
        ...shape(seller),
        ownerPhone: seller.ownerUser?.phone ?? null,
        unsettled: {
          count: unsettled._count,
          gross: Number(unsettled._sum.subtotal ?? 0),
          commission: Number(unsettled._sum.commissionAmount ?? 0),
          netPayable: Number(unsettled._sum.netPayable ?? 0),
        },
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// POST / — onboard a seller by phone (mirrors delivery-agent onboarding; one Seller per login).
const createSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(8),
  commissionPct: z.number().min(0).max(100).optional(),
  city: z.string().optional(),
  gstin: z.string().optional(),
});

router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const name = parsed.data.name.trim();
    const phone = normalizePhone(parsed.data.phone);
    if (phone.length !== 10) throw new ValidationError("Enter a valid 10-digit phone number");

    const existingUser = await prisma.user.findFirst({
      where: { phone: { in: [phone, `+91${phone}`, `91${phone}`] } },
      orderBy: { createdAt: "asc" },
      include: { sellerAccount: { select: { id: true } } },
    });
    if (existingUser?.sellerAccount) {
      throw new ValidationError("This phone is already registered as a seller.");
    }

    const slug = await uniqueSlug(slugify(name));

    const seller = await prisma.$transaction(async (tx) => {
      // Resolve / create the login user and set role = SELLER. firebaseAuth links a pre-created
      // row to the Firebase account on first phone login, keeping this role.
      let userId: string;
      if (existingUser) {
        const keepName = existingUser.name && existingUser.name !== "App User" ? existingUser.name : name;
        const u = await tx.user.update({
          where: { id: existingUser.id },
          data: { role: "SELLER", phone, name: keepName },
        });
        userId = u.id;
      } else {
        const u = await tx.user.create({
          data: { name, phone, role: "SELLER", phoneVerified: false },
        });
        userId = u.id;
      }

      return tx.seller.create({
        data: {
          slug,
          name,
          phone,
          ownerUserId: userId,
          status: "APPROVED",
          commissionPct: parsed.data.commissionPct ?? 5,
          city: parsed.data.city ?? null,
          gstin: parsed.data.gstin ?? null,
        },
        include: INCLUDE,
      });
    });

    res.json({ success: true, data: shape(seller) });
  } catch (e) {
    sendError(res, e);
  }
});

// PATCH /:id — approve/suspend, set commission, rename. The house store is protected (its status,
// commission and active flag are fixed — suspending it would break the existing storefront).
const patchSchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "SUSPENDED"]).optional(),
  commissionPct: z.number().min(0).max(100).optional(),
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const { status, commissionPct, name, isActive } = parsed.data;

    const seller = await prisma.seller.findUnique({ where: { id }, select: { id: true, isHouse: true } });
    if (!seller) throw new NotFoundError("Seller", id);
    if (seller.isHouse && (status !== undefined || commissionPct !== undefined || isActive !== undefined)) {
      throw new ValidationError("The house store can't be suspended or commissioned (manage it in Store Settings).");
    }

    const updated = await prisma.seller.update({
      where: { id },
      data: {
        ...(status !== undefined ? { status } : {}),
        ...(commissionPct !== undefined ? { commissionPct } : {}),
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
      include: INCLUDE,
    });
    res.json({ success: true, data: shape(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/payout — settle the seller's unsettled sub-orders ──
// Sums every unsettled SubOrder, creates a SellerPayout covering them, marks them settled, and
// decrements the running balance. This is the manual-ledger settlement (no Razorpay Route yet).
const payoutSchema = z.object({
  mode: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
  note: z.string().max(300).optional(),
});

router.post("/:id/payout", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = payoutSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid payout data", parsed.error.errors);

    const seller = await prisma.seller.findUnique({ where: { id }, select: { id: true, isHouse: true } });
    if (!seller) throw new NotFoundError("Seller", id);
    if (seller.isHouse) throw new ValidationError("The house store has no commission ledger to pay out.");

    const result = await prisma.$transaction(async (tx) => {
      const unsettled = await tx.subOrder.findMany({
        where: { sellerId: id, settled: false },
        select: { id: true, subtotal: true, commissionAmount: true, tcsAmount: true, netPayable: true },
      });
      if (unsettled.length === 0) throw new ValidationError("Nothing to pay out — no unsettled orders.");

      const gross = +unsettled.reduce((s, o) => s + Number(o.subtotal), 0).toFixed(2);
      const commission = +unsettled.reduce((s, o) => s + Number(o.commissionAmount), 0).toFixed(2);
      const tcs = +unsettled.reduce((s, o) => s + Number(o.tcsAmount), 0).toFixed(2);
      const net = +unsettled.reduce((s, o) => s + Number(o.netPayable), 0).toFixed(2);

      const payout = await tx.sellerPayout.create({
        data: {
          sellerId: id, grossAmount: gross, commission, tcs, netPaid: net,
          mode: parsed.data.mode ?? null, reference: parsed.data.reference ?? null, note: parsed.data.note ?? null,
        },
      });
      await tx.subOrder.updateMany({ where: { id: { in: unsettled.map((o) => o.id) } }, data: { settled: true, payoutId: payout.id } });
      await tx.seller.update({ where: { id }, data: { outstandingBalance: { decrement: net } } });
      return { payout, count: unsettled.length };
    });

    res.json({ success: true, data: { payoutId: result.payout.id, settledCount: result.count, netPaid: Number(result.payout.netPaid) } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /:id/payouts — payout history for a seller ───────────────
router.get("/:id/payouts", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const payouts = await prisma.sellerPayout.findMany({ where: { sellerId: id }, orderBy: { paidAt: "desc" }, take: 50 });
    res.json({
      success: true,
      data: payouts.map((p) => ({
        id: p.id, grossAmount: Number(p.grossAmount), commission: Number(p.commission),
        netPaid: Number(p.netPaid), paidAt: p.paidAt, mode: p.mode, reference: p.reference, note: p.note,
      })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
