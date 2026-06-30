import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, ConflictError, AppError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { admin, isFirebaseInitialized } from "../lib/firebase.js";
import { formatProductForApp } from "./catalog.js";
import { computeUserSavings } from "../services/savings.js";
import { computeUserLoyalty } from "../services/loyalty.js";
import { notifyNewComplaint, notifyNewQuoteRequest } from "../services/fcmNotifier.js";
import { mintReferralWelcomeCoupon } from "../services/referralRewards.js";
import { createTopup, creditTopup } from "../services/walletTopup.js";
import { verifyPaymentSignature, createRazorpayOrder, isRazorpayConfigured } from "../services/razorpay.js";
import {
  markQuotePaid,
  getQuoteAdvancePercent,
  computeQuoteCharge,
  reconcileQuotePayment,
} from "../services/quotePayment.js";
import { materializeQuoteOrder } from "../services/quoteToOrder.js";
import {
  requestAccountDeletion,
  getDeletionBlockers,
  analyzeWallet,
} from "../services/accountDeletion.js";

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

// GET /api/app/me/savings — cumulative savings (year-to-date + all-time)
router.get("/savings", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const savings = await computeUserSavings(req.appUser!.id);
    res.json({ success: true, data: savings });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/me/loyalty — tier, spend, progress to next tier, perks
router.get("/loyalty", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const loyalty = await computeUserLoyalty(req.appUser!.id);
    res.json({ success: true, data: loyalty });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/me/essentials — products the user reorders, with a "running low" prediction.
// A product qualifies if bought in ≥2 distinct orders. runningLow = days-since-last ≥ 0.8 × the
// median gap between past purchases. Pure derivation from existing orders; no extra tracking.
router.get("/essentials", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const orders = await prisma.order.findMany({
      where: { customerId: userId, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { createdAt: true, items: { select: { variantId: true } } },
    });
    if (orders.length < 2) return res.json({ success: true, data: [] });

    // variant → product
    const allVariantIds = [
      ...new Set(orders.flatMap((o) => o.items.map((i) => i.variantId).filter((v): v is string => !!v))),
    ];
    if (allVariantIds.length === 0) return res.json({ success: true, data: [] });
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: allVariantIds } },
      select: { id: true, productId: true },
    });
    const productByVariant = new Map(variants.map((v) => [v.id, v.productId]));

    // product → purchase dates (one per order that contained it)
    const datesByProduct = new Map<string, number[]>();
    for (const o of orders) {
      const productsInOrder = new Set<string>();
      for (const it of o.items) {
        const pid = it.variantId ? productByVariant.get(it.variantId) : undefined;
        if (pid) productsInOrder.add(pid);
      }
      for (const pid of productsInOrder) {
        if (!datesByProduct.has(pid)) datesByProduct.set(pid, []);
        datesByProduct.get(pid)!.push(o.createdAt.getTime());
      }
    }

    const now = Date.now();
    const DAY = 86_400_000;
    const candidates = [...datesByProduct.entries()]
      .filter(([, dates]) => dates.length >= 2)
      .map(([pid, dates]) => {
        const sorted = [...dates].sort((a, b) => b - a); // newest first
        const gaps: number[] = [];
        for (let i = 0; i < sorted.length - 1; i++) gaps.push((sorted[i]! - sorted[i + 1]!) / DAY);
        gaps.sort((a, b) => a - b);
        const median = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0;
        const daysSinceLast = (now - sorted[0]!) / DAY;
        const runningLow = median > 0 && daysSinceLast >= 0.8 * median;
        return { pid, count: dates.length, runningLow };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    if (candidates.length === 0) return res.json({ success: true, data: [] });

    const products = await prisma.catalogProduct.findMany({
      where: { id: { in: candidates.map((c) => c.pid) }, isActive: true },
      include: {
        variants: { where: { isActive: true }, orderBy: { packageSize: "asc" } },
        category: { select: { slug: true, name: true } },
        seller: { select: { id: true, name: true, isHouse: true } },
      },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const data = candidates
      .map((c) => {
        const p = byId.get(c.pid);
        return p ? { product: formatProductForApp(p), runningLow: c.runningLow } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /api/app/me
const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  // The app may send "" for an untouched optional field — treat it as null.
  email: z.preprocess(
    (v) => (v === "" ? null : v),
    z.string().email().nullable().optional(),
  ),
  // Firebase Auth phones arrive as "+91XXXXXXXXXX" — normalize to bare 10 digits.
  phone: z.preprocess(
    (v) =>
      typeof v === "string"
        ? v.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "") || null
        : v,
    z.string().regex(/^[6-9]\d{9}$/, "Phone must be 10 digits starting with 6-9").nullable().optional(),
  ),
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
    // email is @unique — another account may already use it.
    if ((e as { code?: string })?.code === "P2002") {
      return sendError(res, new ConflictError("This email is already used by another account."));
    }
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
            seller: { select: { id: true, name: true, isHouse: true } },
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

function genReferralCode(name: string): string {
  const base = (name || "ONE").replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 4) || "ONE";
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${rand}`;
}

// GET /api/app/me/referral → the user's code (generated on first access) + stats + wallet
router.get("/referral", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true, walletBalance: true },
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

    const [referredCount, earned, cfg] = await Promise.all([
      prisma.user.count({ where: { referredById: userId } }),
      prisma.walletTransaction.aggregate({
        _sum: { amount: true },
        where: { userId, type: "REFERRAL_CREDIT" },
      }),
      prisma.storeConfig.findFirst(),
    ]);

    const getAmount = cfg?.referralRewardAmount ?? 50;   // referrer earns (store credit)
    const giveAmount = cfg?.referralWelcomeAmount ?? 50;  // referee gets (welcome coupon)

    res.json({
      success: true,
      data: {
        code,
        referredCount,
        reward: `₹${giveAmount} off`,
        walletBalance: Number(user?.walletBalance ?? 0),
        totalEarned: Number(earned._sum.amount ?? 0),
        giveAmount,
        getAmount,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/me/wallet → store-credit balance + recent transaction history
router.get("/wallet", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const [user, txns] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { walletBalance: true } }),
      prisma.walletTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true, amount: true, type: true, balanceAfter: true,
          note: true, orderId: true, createdAt: true,
        },
      }),
    ]);
    res.json({
      success: true,
      data: {
        balance: Number(user?.walletBalance ?? 0),
        transactions: txns.map((t) => ({
          id: t.id,
          amount: Number(t.amount),
          type: t.type,
          balanceAfter: Number(t.balanceAfter),
          note: t.note,
          orderId: t.orderId,
          createdAt: t.createdAt.getTime(),
        })),
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Wallet top-up (money-in via Razorpay) ───────────────────────────

const topupSchema = z.object({ amount: z.number().positive() });

// POST /api/app/me/wallet/topup { amount } → create a PENDING top-up + Razorpay order.
// The wallet is credited only after payment confirmation (the /pay route below OR the webhook OR
// reconciliation), so a killed app can't lose the loaded money.
router.post("/wallet/topup", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = topupSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid top-up amount", parsed.error.errors);
    const result = await createTopup(req.appUser!.id, parsed.data.amount);
    res.status(201).json({ success: true, data: result });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/me/wallet/topup/:id/pay { razorpayPaymentId, razorpaySignature }
// Fast-path confirmation from the app. Verifies the Razorpay signature, then credits idempotently
// (the webhook/reconciliation would credit the same top-up exactly once anyway).
const topupPaySchema = z.object({
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

router.post("/wallet/topup/:id/pay", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = topupPaySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid payment data", parsed.error.errors);
    const { razorpayPaymentId, razorpaySignature } = parsed.data;

    const topup = await prisma.walletTopup.findFirst({
      where: { id: req.params.id, userId: req.appUser!.id },
    });
    if (!topup) throw new NotFoundError("WalletTopup", req.params.id!);
    if (!topup.razorpayOrderId) throw new ValidationError("This top-up has no pending payment");

    const isValid = verifyPaymentSignature(topup.razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!isValid) throw new AppError(400, "PAYMENT_INVALID", "Payment signature verification failed");

    await creditTopup(topup.id, razorpayPaymentId);

    const user = await prisma.user.findUnique({
      where: { id: req.appUser!.id },
      select: { walletBalance: true },
    });
    res.json({
      success: true,
      message: "Top-up added",
      data: { topupId: topup.id, balance: Number(user?.walletBalance ?? 0) },
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

    const cfg = await prisma.storeConfig.findFirst();
    const welcomeAmount = cfg?.referralWelcomeAmount ?? 50;
    const minOrder = cfg?.referralMinOrder ?? 199;
    const expiryDays = cfg?.referralWelcomeExpiryDays ?? 30;
    const referralEnabled = cfg?.referralEnabled ?? true;

    // Link the referee → referrer (one-time), mint the welcome coupon, and open the Referral record
    // (PENDING) that gates the referrer's later store-credit payout — all atomically.
    const welcome = await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { referredById: referrer.id } });

      const minted = referralEnabled
        ? await mintReferralWelcomeCoupon(tx, { amount: welcomeAmount, minOrder, expiryDays })
        : null;

      await tx.referral.create({
        data: {
          referrerId: referrer.id,
          refereeId: userId,
          status: "PENDING",
          welcomeCouponCode: minted?.code ?? null,
        },
      });
      return minted;
    });

    res.json({
      success: true,
      message: welcome
        ? `Welcome reward unlocked — ₹${welcome.amount} off your first order!`
        : "Referral applied!",
      data: {
        reward: `₹${welcomeAmount} off`,
        welcomeCoupon: welcome
          ? {
              code: welcome.code,
              amount: welcome.amount,
              minOrder: welcome.minOrder,
              expiresAt: welcome.expiresAt.toISOString(),
            }
          : null,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Complaints + Quote requests (shared shapes — also used by the owner routes)
// ═══════════════════════════════════════════════════════════════════════

// Short human-facing ids derived from the cuid (the app shows these).
export function shapeComplaint(c: {
  id: string; subject: string; message: string; status: string;
  orderId: string | null; createdAt: Date; resolvedAt: Date | null;
  user?: { name: string; phone: string | null } | null;
}) {
  return {
    id: c.id,
    complaintNumber: "CMP-" + c.id.slice(-6).toUpperCase(),
    subject: c.subject,
    message: c.message,
    status: c.status, // OPEN | RESOLVED
    orderId: c.orderId,
    createdAt: c.createdAt.getTime(),
    resolvedAt: c.resolvedAt ? c.resolvedAt.getTime() : null,
    customerName: c.user?.name ?? null,
    customerPhone: c.user?.phone ?? null,
  };
}

export function shapeQuote(q: {
  id: string; type: string; note: string; eventDate: string | null;
  imageUrls: string[]; status: string; quotedAmount: unknown; deliveryFee?: unknown;
  quoteMessage: string | null; paymentStatus?: string; paymentOption?: string | null;
  amountPaid?: unknown; razorpayOrderId?: string | null; orderId?: string | null; createdAt: Date;
  items?: { name: string; qty: string; amount: unknown; sortOrder: number; variantId?: string | null }[];
  user?: { name: string; phone: string | null } | null;
}) {
  const paymentStatus = q.paymentStatus ?? "UNPAID";
  return {
    id: q.id,
    requestNumber: "QR-" + q.id.slice(-6).toUpperCase(),
    type: q.type,
    note: q.note,
    eventDate: q.eventDate,
    imageUrls: q.imageUrls,
    status: q.status, // PENDING | QUOTED | ACCEPTED | DECLINED | FULFILLED
    quotedAmount: q.quotedAmount != null ? Number(q.quotedAmount) : 0,
    deliveryFee: q.deliveryFee != null ? Number(q.deliveryFee) : 0,
    paymentStatus, // UNPAID | PAID | ADVANCE_PAID
    paymentOption: q.paymentOption ?? "FULL", // FULL | ADVANCE
    amountPaid: q.amountPaid != null ? Number(q.amountPaid) : 0,
    // True when an online payment was started (Razorpay order created) but never confirmed — the app
    // calls /reconcile on open so a killed-mid-pay payment is recovered.
    hasPendingPayment: q.status === "QUOTED" && !!q.razorpayOrderId && paymentStatus === "UNPAID",
    quoteMessage: q.quoteMessage,
    // Bulk Express: set once the quote is converted to a fulfillment order → the app deep-links the
    // customer to live order tracking and drives the status stepper from the order's real status.
    orderId: q.orderId ?? null,
    items: (q.items ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((it) => ({ name: it.name, qty: it.qty, amount: Number(it.amount), variantId: it.variantId ?? null })),
    createdAt: q.createdAt.getTime(),
    customerName: q.user?.name ?? null,
    customerPhone: q.user?.phone ?? null,
  };
}

const complaintSchema = z.object({
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  orderId: z.string().max(100).optional().nullable(),
});

// POST /api/app/me/complaints → register a complaint (+ best-effort owner push)
router.post("/complaints", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = complaintSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid complaint", parsed.error.errors);

    const complaint = await prisma.complaint.create({
      data: {
        userId: req.appUser!.id,
        subject: parsed.data.subject.trim(),
        message: parsed.data.message.trim(),
        orderId: parsed.data.orderId || null,
      },
    });

    // Notify the owner — never let a push failure fail the create.
    try {
      await notifyNewComplaint({ id: complaint.id, subject: complaint.subject, customerName: req.appUser!.name });
    } catch (notifyErr) {
      console.warn("notifyNewComplaint failed:", notifyErr);
    }

    res.status(201).json({ success: true, data: shapeComplaint({ ...complaint }) });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/me/complaints → the caller's complaints (newest first)
router.get("/complaints", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const complaints = await prisma.complaint.findMany({
      where: { userId: req.appUser!.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: complaints.map((c) => shapeComplaint({ ...c })) });
  } catch (e) {
    sendError(res, e);
  }
});

const quoteRequestSchema = z.object({
  type: z.string().min(1).max(50),
  note: z.string().max(2000).default(""),
  eventDate: z.string().max(100).optional().nullable(),
  imageUrls: z.array(z.string().max(1000)).max(8).default([]),
});

// POST /api/app/me/quote-requests → submit a quote request (+ best-effort owner push)
router.post("/quote-requests", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = quoteRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid quote request", parsed.error.errors);

    const quote = await prisma.quoteRequest.create({
      data: {
        userId: req.appUser!.id,
        type: parsed.data.type.trim(),
        note: parsed.data.note.trim(),
        eventDate: parsed.data.eventDate || null,
        imageUrls: parsed.data.imageUrls,
      },
    });

    try {
      await notifyNewQuoteRequest({ id: quote.id, type: quote.type, customerName: req.appUser!.name });
    } catch (notifyErr) {
      console.warn("notifyNewQuoteRequest failed:", notifyErr);
    }

    res.status(201).json({ success: true, data: shapeQuote({ ...quote }) });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/me/quote-requests → the caller's quote requests (newest first)
router.get("/quote-requests", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const quotes = await prisma.quoteRequest.findMany({
      where: { userId: req.appUser!.id },
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });
    res.json({ success: true, data: quotes.map((q) => shapeQuote({ ...q })) });
  } catch (e) {
    sendError(res, e);
  }
});

const respondQuoteSchema = z.object({
  accept: z.boolean(),
  // Delivery address chosen on a direct (pay-on-delivery) accept.
  addressId: z.string().max(40).optional().nullable(),
});

// POST /api/app/me/quote-requests/:id/respond → customer declines (or accepts pay-on-delivery)
// a QUOTED price. Online payment goes through /approve + /pay instead (see below).
router.post("/quote-requests/:id/respond", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = respondQuoteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid response", parsed.error.errors);

    const id = String(req.params.id ?? "");
    const quote = await prisma.quoteRequest.findFirst({
      where: { id, userId: req.appUser!.id },
    });
    if (!quote) throw new NotFoundError("Quote request", id);
    if (quote.status !== "QUOTED") {
      throw new ValidationError("This request isn't awaiting your response.");
    }

    // Store the chosen delivery address before conversion (accept path only).
    if (parsed.data.accept) {
      await setQuoteAddress(quote.id, req.appUser!.id, parsed.data.addressId);
    }

    const updated = await prisma.quoteRequest.update({
      where: { id: quote.id },
      data: { status: parsed.data.accept ? "ACCEPTED" : "DECLINED" },
      include: { items: true },
    });
    // Bulk Express: a direct accept (pay-on-delivery) also materializes the fulfillment order.
    if (parsed.data.accept) {
      try {
        await materializeQuoteOrder(quote.id);
      } catch (convErr) {
        console.warn("materializeQuoteOrder (respond accept) failed:", convErr);
      }
    }
    const fresh = await prisma.quoteRequest.findUnique({ where: { id: quote.id }, include: { items: true } });
    res.json({ success: true, data: shapeQuote({ ...(fresh ?? updated) }) });
  } catch (e) {
    sendError(res, e);
  }
});

const approveQuoteSchema = z.object({
  // FULL = pay the whole total online; ADVANCE = pay only the advance % now, rest on delivery.
  paymentOption: z.enum(["FULL", "ADVANCE"]).default("FULL"),
  // Delivery address the customer chose at approval (validated to belong to them, then stored on the
  // quote so the conversion snapshots it onto the order). Null → fall back to the default address.
  addressId: z.string().max(40).optional().nullable(),
});

// Validates an addressId belongs to the caller and persists it on the quote so materializeQuoteOrder
// can snapshot it. No-op when addressId is null/blank. Throws if the address isn't the caller's.
async function setQuoteAddress(quoteId: string, userId: string, addressId?: string | null) {
  if (!addressId) return;
  const addr = await prisma.address.findFirst({ where: { id: addressId, userId }, select: { id: true } });
  if (!addr) throw new ValidationError("That delivery address was not found.");
  await prisma.quoteRequest.update({ where: { id: quoteId }, data: { addressId } });
}

// POST /api/app/me/quote-requests/:id/approve → customer approves a QUOTED price.
// Body { paymentOption: "FULL" | "ADVANCE" }. If the chargeable amount is payable AND Razorpay is
// configured, this creates a Razorpay order for that amount (the whole total for FULL, the advance %
// for ADVANCE) and returns { paymentRequired: true, razorpayOrderId, amountPaise, paymentOption } —
// the app opens the Razorpay SDK and confirms via /pay. Otherwise (₹0 / Razorpay off) the request is
// marked ACCEPTED right away (settled as pay-on-delivery) and { paymentRequired: false } is returned.
router.post("/quote-requests/:id/approve", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = approveQuoteSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError("Invalid approval", parsed.error.errors);
    const paymentOption = parsed.data.paymentOption;

    const id = String(req.params.id ?? "");
    const quote = await prisma.quoteRequest.findFirst({
      where: { id, userId: req.appUser!.id },
    });
    if (!quote) throw new NotFoundError("Quote request", id);
    if (quote.status !== "QUOTED") {
      throw new ValidationError("This request isn't awaiting your approval.");
    }

    // Persist the chosen delivery address before any conversion runs (the paid path materializes the
    // order later in markQuotePaid, so it must already be on the quote).
    await setQuoteAddress(quote.id, req.appUser!.id, parsed.data.addressId);

    const total = quote.quotedAmount != null ? Number(quote.quotedAmount) : 0;
    const advancePercent = paymentOption === "ADVANCE" ? await getQuoteAdvancePercent() : 0;
    const chargeAmount = computeQuoteCharge(total, paymentOption, advancePercent);

    if (total > 0 && isRazorpayConfigured()) {
      const amountPaise = Math.round(chargeAmount * 100);
      const rp = await createRazorpayOrder(amountPaise, `quote_${quote.id}`);
      // Record the chosen option so /pay + webhook + reconcile credit the right amount.
      await prisma.quoteRequest.update({
        where: { id: quote.id },
        data: { razorpayOrderId: rp.id, paymentOption },
      });
      res.json({
        success: true,
        data: { paymentRequired: true, razorpayOrderId: rp.id, amountPaise, paymentOption },
      });
      return;
    }

    // No online payment needed/possible → accept now (pay on delivery). The chosen option is still
    // recorded so the owner knows the customer's intent.
    await prisma.quoteRequest.update({
      where: { id: quote.id },
      data: { status: "ACCEPTED", paymentOption },
    });
    // Bulk Express: turn the accepted quote into a real fulfillment Order (delivery pipeline +
    // invoice + OTP). Best-effort — a conversion hiccup must not fail the approval the customer just
    // made; the owner can re-trigger via /fulfill, and the order is idempotent on re-run.
    try {
      await materializeQuoteOrder(quote.id);
    } catch (convErr) {
      console.warn("materializeQuoteOrder (pay-on-delivery) failed:", convErr);
    }
    res.json({
      success: true,
      data: { paymentRequired: false, razorpayOrderId: null, amountPaise: 0, paymentOption },
    });
  } catch (e) {
    sendError(res, e);
  }
});

const quotePaySchema = z.object({
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

// POST /api/app/me/quote-requests/:id/pay → verify the Razorpay payment for an approved quote.
// On a valid signature: paymentStatus → PAID/ADVANCE_PAID and status → ACCEPTED (idempotent, via the
// shared markQuotePaid path that the webhook + reconcile also use).
router.post("/quote-requests/:id/pay", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = quotePaySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid payment data", parsed.error.errors);
    const { razorpayPaymentId, razorpaySignature } = parsed.data;

    const id = String(req.params.id ?? "");
    const quote = await prisma.quoteRequest.findFirst({
      where: { id, userId: req.appUser!.id },
    });
    if (!quote) throw new NotFoundError("Quote request", id);
    if (quote.paymentStatus !== "UNPAID") {
      const fresh = await prisma.quoteRequest.findUnique({ where: { id: quote.id }, include: { items: true } });
      res.json({ success: true, data: shapeQuote({ ...fresh! }) });
      return;
    }
    if (!quote.razorpayOrderId) throw new ValidationError("This quote has no pending payment.");

    const isValid = verifyPaymentSignature(quote.razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!isValid) throw new AppError(400, "PAYMENT_INVALID", "Payment signature verification failed");

    await markQuotePaid(quote.id, razorpayPaymentId);
    const updated = await prisma.quoteRequest.findUnique({ where: { id: quote.id }, include: { items: true } });
    res.json({ success: true, message: "Payment verified", data: shapeQuote({ ...updated! }) });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/me/quote-requests/:id/reconcile → recover a stranded quote payment.
// Belt-and-suspenders for "paid but app closed": the app calls this on opening a quote whose online
// payment was started but never confirmed. The server asks Razorpay whether the payment was captured
// and, if so, marks the quote PAID/ADVANCE_PAID (idempotent; harmless otherwise). Returns the quote.
router.post("/quote-requests/:id/reconcile", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const quote = await prisma.quoteRequest.findFirst({
      where: { id, userId: req.appUser!.id },
      select: { id: true },
    });
    if (!quote) throw new NotFoundError("Quote request", id);

    await reconcileQuotePayment(quote.id);
    const fresh = await prisma.quoteRequest.findUnique({ where: { id: quote.id }, include: { items: true } });
    res.json({ success: true, data: shapeQuote({ ...fresh! }) });
  } catch (e) {
    sendError(res, e);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Account deletion (required by Google Play account-deletion policy)
// ═══════════════════════════════════════════════════════════════════════

// GET /api/app/me/deletion-eligibility
// Pre-flight: lets the app show the user what (if anything) blocks deletion, plus how their
// wallet money will be handled (refundable real money vs forfeited promotional credit), BEFORE
// they confirm. Literal path — safe ahead of the me-root routes (no GET /:param wildcard exists).
router.get("/deletion-eligibility", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const [blockers, wallet] = await Promise.all([
      getDeletionBlockers(userId),
      analyzeWallet(userId),
    ]);
    res.json({
      success: true,
      data: { canDelete: blockers.length === 0, blockers, wallet },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /api/app/me
// Obligation-aware SOFT deletion (see services/accountDeletion.ts): refuses while subscriptions /
// khata / a bulk advance / in-flight orders are open (409 with a readable message), else marks the
// account PENDING_DELETION and starts the grace clock. Money + records stay intact during the
// window so the user can restore by signing in again; the sweeper refunds the wallet + scrubs PII
// only once the grace window elapses.
router.delete("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const result = await requestAccountDeletion(req.appUser!.id);
    res.json({
      success: true,
      message: `Your account will be permanently deleted in ${result.graceDays} days. Sign in again before then to cancel.`,
      data: result,
    });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
