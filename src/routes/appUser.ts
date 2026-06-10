import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { admin, isFirebaseInitialized } from "../lib/firebase.js";
import { formatProductForApp } from "./catalog.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);

// ═══════════════════════════════════════════════════════════════════════
// Profile
// ═══════════════════════════════════════════════════════════════════════

// GET /api/app/me
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.appUser!.id },
      select: {
        id: true, name: true, email: true, phone: true, photoUrl: true,
        role: true, phoneVerified: true, createdAt: true,
      },
    });
    if (!user) throw new NotFoundError("User", req.appUser!.id);
    res.json({ success: true, data: user });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /api/app/me
const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional().nullable(),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Phone must be 10 digits starting with 6-9").optional().nullable(),
  photoUrl: z.string().max(500).optional().nullable(),
});

router.put("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);

    // If the phone number changes, it is no longer verified — force re-verification.
    const data: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.phone !== undefined && parsed.data.phone !== req.appUser!.phone) {
      data.phoneVerified = false;
    }

    const user = await prisma.user.update({
      where: { id: req.appUser!.id },
      data,
      select: {
        id: true, name: true, email: true, phone: true, photoUrl: true,
        role: true, phoneVerified: true, createdAt: true,
      },
    });

    res.json({ success: true, data: user });
  } catch (e) {
    sendError(res, e);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Addresses
// ═══════════════════════════════════════════════════════════════════════

// GET /api/app/addresses
router.get("/addresses", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const addresses = await prisma.address.findMany({
      where: { userId: req.appUser!.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
    res.json({ success: true, data: addresses });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/addresses
const addressSchema = z.object({
  label: z.string().min(1).max(50).default("Home"),
  addressLine: z.string().min(1).max(300),
  landmark: z.string().max(200).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  pincode: z.string().regex(/^\d{6}$/, "Pincode must be 6 digits"),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
  isDefault: z.boolean().default(false),
});

router.post("/addresses", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = addressSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid address", parsed.error.errors);
    const userId = req.appUser!.id;

    // Cap addresses per user to prevent unbounded row creation.
    const addressCount = await prisma.address.count({ where: { userId } });
    if (addressCount >= 20) {
      throw new ValidationError("You can save at most 20 addresses. Please delete one first.");
    }

    // If setting as default, unset others
    if (parsed.data.isDefault) {
      await prisma.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const address = await prisma.address.create({
      data: { ...parsed.data, userId },
    });

    res.status(201).json({ success: true, data: address });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /api/app/addresses/:id
router.put("/addresses/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const existing = await prisma.address.findFirst({
      where: { id: req.params.id, userId },
    });
    if (!existing) throw new NotFoundError("Address", req.params.id!);

    const parsed = addressSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid address", parsed.error.errors);

    if (parsed.data.isDefault) {
      await prisma.address.updateMany({
        where: { userId, isDefault: true, id: { not: existing.id } },
        data: { isDefault: false },
      });
    }

    const address = await prisma.address.update({
      where: { id: existing.id },
      data: parsed.data,
    });

    res.json({ success: true, data: address });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /api/app/addresses/:id
router.delete("/addresses/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const existing = await prisma.address.findFirst({
      where: { id: req.params.id, userId },
    });
    if (!existing) throw new NotFoundError("Address", req.params.id!);

    await prisma.address.delete({ where: { id: existing.id } });
    res.json({ success: true, message: "Address deleted" });
  } catch (e) {
    sendError(res, e);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Favorites (wishlist — product-level)
// ═══════════════════════════════════════════════════════════════════════

// GET /api/app/me/favorites → the user's favorited products (full app product shape)
router.get("/favorites", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const favorites = await prisma.favorite.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        product: {
          include: {
            variants: { where: { isActive: true }, orderBy: { packageSize: "asc" } },
            category: { select: { slug: true, name: true } },
          },
        },
      },
    });
    // Only surface products that are still active.
    const products = favorites
      .map((f) => f.product)
      .filter((p) => p && p.isActive)
      .map(formatProductForApp);
    res.json({ success: true, data: products });
  } catch (e) {
    sendError(res, e);
  }
});

const favoriteSchema = z.object({ productId: z.string().min(1) });

// POST /api/app/me/favorites { productId } → idempotent add
router.post("/favorites", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const parsed = favoriteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid favorite", parsed.error.errors);

    const product = await prisma.catalogProduct.findUnique({ where: { id: parsed.data.productId } });
    if (!product) throw new NotFoundError("Product", parsed.data.productId);

    await prisma.favorite.upsert({
      where: { userId_productId: { userId, productId: parsed.data.productId } },
      create: { userId, productId: parsed.data.productId },
      update: {},
    });
    res.status(201).json({ success: true, message: "Added to favorites" });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /api/app/me/favorites/:productId → idempotent remove
router.delete("/favorites/:productId", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    await prisma.favorite.deleteMany({
      where: { userId, productId: req.params.productId },
    });
    res.json({ success: true, message: "Removed from favorites" });
  } catch (e) {
    sendError(res, e);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Referral program (refer & earn)
// ═══════════════════════════════════════════════════════════════════════

// Both referrer and referee get this. Surfaced to the app for display copy.
const REFERRAL_REWARD_LABEL = "₹50 off";

function genReferralCode(name: string): string {
  const base = (name || "ONE").replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 4) || "ONE";
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${rand}`;
}

// GET /api/app/me/referral → the user's code (generated on first access) + stats
router.get("/referral", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });

    let code = user?.referralCode ?? null;
    if (!code) {
      // Generate a unique code (retry a few times on the rare collision).
      for (let i = 0; i < 6; i++) {
        const candidate = genReferralCode(req.appUser!.name);
        const taken = await prisma.user.findUnique({
          where: { referralCode: candidate },
          select: { id: true },
        });
        if (!taken) {
          await prisma.user.update({ where: { id: userId }, data: { referralCode: candidate } });
          code = candidate;
          break;
        }
      }
    }

    const referredCount = await prisma.user.count({ where: { referredById: userId } });

    res.json({
      success: true,
      data: { code, referredCount, reward: REFERRAL_REWARD_LABEL },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/me/referral/apply { code } → link the referee to a referrer (once)
const applyReferralSchema = z.object({ code: z.string().min(3).max(20) });

router.post("/referral/apply", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const parsed = applyReferralSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid referral code", parsed.error.errors);
    const code = parsed.data.code.trim().toUpperCase();

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { referredById: true, referralCode: true },
    });
    if (me?.referredById) throw new ValidationError("You've already applied a referral code.");
    if (me?.referralCode && me.referralCode === code) throw new ValidationError("You can't use your own code.");

    const referrer = await prisma.user.findUnique({
      where: { referralCode: code },
      select: { id: true },
    });
    if (!referrer) throw new NotFoundError("Referral code", code);
    if (referrer.id === userId) throw new ValidationError("You can't use your own code.");

    await prisma.user.update({ where: { id: userId }, data: { referredById: referrer.id } });

    res.json({
      success: true,
      message: "Referral applied! Enjoy your reward.",
      data: { reward: REFERRAL_REWARD_LABEL },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Account deletion (required by Google Play account-deletion policy)
// ═══════════════════════════════════════════════════════════════════════

// DELETE /api/app/me
// Permanently deletes the user's personal data and Firebase credential. Orders
// are RETAINED but anonymized — the Order→User relation is Restrict and invoices
// must be kept for GST/accounting/legal retention, so we scrub PII on the user
// row rather than removing it.
router.delete("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const firebaseUid = req.appUser!.firebaseUid;

    await prisma.$transaction(async (tx) => {
      await tx.address.deleteMany({ where: { userId } });
      await tx.cartItem.deleteMany({ where: { userId } });
      await tx.fcmToken.deleteMany({ where: { userId } });
      await tx.favorite.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          name: "Deleted User",
          email: null,
          phone: null,
          photoUrl: null,
          phoneVerified: false,
          isActive: false,
          firebaseUid: null,
          passwordHash: null,
        },
      });
    });

    // Revoke the Firebase credential so the account cannot be used again.
    if (firebaseUid && isFirebaseInitialized()) {
      try {
        await admin.auth().deleteUser(firebaseUid);
      } catch (err: any) {
        console.warn("Firebase user deletion failed (data already anonymized):", err?.message);
      }
    }

    res.json({ success: true, message: "Account deleted" });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
