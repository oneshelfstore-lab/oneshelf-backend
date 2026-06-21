import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, AppError } from "../lib/errors.js";
import { firebaseAuthMiddleware, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import {
  istMidnight,
  firstDeliveryOnOrAfter,
  computeNextDeliveryDate,
  upcomingDates,
  type CadenceLike,
} from "../services/subscriptionEngine.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);

function isLooseType(t: string) {
  return t === "LOOSE" || t === "PRODUCE";
}

// ─── validation ──────────────────────────────────────────────────────
const cadenceShape = {
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "CUSTOM"]),
  intervalDays: z.number().int().min(1).max(90).optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional().default([]),
  dayOfMonth: z.number().int().min(1).max(28).optional().nullable(),
  startDate: z.string().min(1),
  endDate: z.string().optional().nullable(),
};

const createSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().positive(),
  addressId: z.string().min(1),
  billing: z.enum(["COD", "WALLET"]).default("COD"), // AUTOPAY is Phase 4
  ...cadenceShape,
});

const updateSchema = z.object({
  quantity: z.number().positive().optional(),
  addressId: z.string().min(1).optional(),
  billing: z.enum(["COD", "WALLET"]).optional(),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "CUSTOM"]).optional(),
  intervalDays: z.number().int().min(1).max(90).optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional().nullable(),
  startDate: z.string().optional(),
  endDate: z.string().optional().nullable(),
});

// Cadence coherence: the fields required by the chosen frequency must be present + valid.
function assertCadence(c: { frequency: string; daysOfWeek?: number[]; dayOfMonth?: number | null; intervalDays?: number | null }) {
  if (c.frequency === "WEEKLY" && (!c.daysOfWeek || c.daysOfWeek.length === 0)) {
    throw new ValidationError("Pick at least one weekday for a weekly subscription");
  }
  if (c.frequency === "MONTHLY" && (c.dayOfMonth == null || c.dayOfMonth < 1 || c.dayOfMonth > 28)) {
    throw new ValidationError("Pick a day of month (1–28) for a monthly subscription");
  }
  if (c.frequency === "CUSTOM" && (c.intervalDays == null || c.intervalDays < 1)) {
    throw new ValidationError("Set an interval (every N days) for a custom subscription");
  }
}

function toCadence(row: {
  frequency: string;
  intervalDays: number | null;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  startDate: Date;
  endDate: Date | null;
}): CadenceLike {
  return {
    frequency: row.frequency as CadenceLike["frequency"],
    intervalDays: row.intervalDays,
    daysOfWeek: row.daysOfWeek,
    dayOfMonth: row.dayOfMonth,
    startDate: row.startDate,
    endDate: row.endDate,
  };
}

function serialize(sub: any) {
  return {
    ...sub,
    quantity: Number(sub.quantity),
    stepSize: sub.stepSize == null ? null : Number(sub.stepSize),
  };
}

// ─── GET /  — my subscriptions ───────────────────────────────────────
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const subs = await prisma.subscription.findMany({
      where: { customerId: req.appUser!.id, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: subs.map(serialize) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /statements  — my monthly subscription bills ────────────────
// Declared BEFORE "/:id" so Express doesn't match "statements" as a subscription id.
router.get("/statements", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const statements = await prisma.subscriptionStatement.findMany({
      where: { customerId: req.appUser!.id },
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
    });
    res.json({
      success: true,
      data: statements.map((s) => ({ ...s, totalAmount: Number(s.totalAmount) })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /  — create a subscription ─────────────────────────────────
router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid subscription", parsed.error.errors);
    const d = parsed.data;
    assertCadence(d);

    const config = await prisma.storeConfig.findFirst();
    if (config && !config.subscriptionsEnabled) {
      throw new AppError(403, "SUBSCRIPTIONS_DISABLED", "Subscriptions are not available right now.");
    }

    const variant = await prisma.productVariant.findUnique({
      where: { id: d.variantId },
      include: { product: { select: { name: true, productType: true, imageUrls: true, isSubscribable: true } } },
    });
    if (!variant || !variant.isActive) throw new NotFoundError("Product", d.variantId);
    if (!variant.product.isSubscribable) {
      throw new ValidationError("This product can't be subscribed to.");
    }

    const address = await prisma.address.findFirst({ where: { id: d.addressId, userId } });
    if (!address) throw new NotFoundError("Address", d.addressId);

    const isLoose = isLooseType(variant.product.productType);
    const startDate = istMidnight(new Date(d.startDate));
    const endDate = d.endDate ? istMidnight(new Date(d.endDate)) : null;
    const cadence = toCadence({
      frequency: d.frequency,
      intervalDays: d.intervalDays ?? null,
      daysOfWeek: d.daysOfWeek ?? [],
      dayOfMonth: d.dayOfMonth ?? null,
      startDate,
      endDate,
    });
    // Seed the cursor: first valid delivery on/after max(today, startDate).
    const today = istMidnight(new Date());
    const seedFrom = startDate > today ? startDate : today;
    const nextDeliveryDate = firstDeliveryOnOrAfter(cadence, seedFrom);

    const sub = await prisma.subscription.create({
      data: {
        customerId: userId,
        variantId: d.variantId,
        productName: variant.product.name,
        imageUrl: variant.product.imageUrls?.[0] ?? null,
        quantity: d.quantity,
        isLoose,
        stepSize: isLoose ? variant.packageSize : null,
        stepUnit: isLoose ? variant.packageUnit : null,
        frequency: d.frequency,
        intervalDays: d.intervalDays ?? null,
        daysOfWeek: d.daysOfWeek ?? [],
        dayOfMonth: d.dayOfMonth ?? null,
        addressId: d.addressId,
        billing: d.billing,
        startDate,
        endDate,
        nextDeliveryDate,
      },
    });

    res.status(201).json({ success: true, data: serialize(sub) });
  } catch (e) {
    sendError(res, e);
  }
});

// Helper: load a subscription owned by the caller (or 404).
async function ownedSub(userId: string, id: string) {
  const sub = await prisma.subscription.findFirst({ where: { id, customerId: userId } });
  if (!sub) throw new NotFoundError("Subscription", id);
  return sub;
}

// ─── PATCH /:id  — edit qty / cadence / address / billing ────────────
router.patch("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid update", parsed.error.errors);
    const d = parsed.data;
    const existing = await ownedSub(userId, req.params.id as string);

    if (d.addressId) {
      const address = await prisma.address.findFirst({ where: { id: d.addressId, userId } });
      if (!address) throw new NotFoundError("Address", d.addressId);
    }

    // Merge cadence to validate + recompute the cursor when cadence/start changed.
    const merged = {
      frequency: d.frequency ?? existing.frequency,
      intervalDays: d.intervalDays !== undefined ? d.intervalDays : existing.intervalDays,
      daysOfWeek: d.daysOfWeek ?? existing.daysOfWeek,
      dayOfMonth: d.dayOfMonth !== undefined ? d.dayOfMonth : existing.dayOfMonth,
      startDate: d.startDate ? istMidnight(new Date(d.startDate)) : existing.startDate,
      endDate: d.endDate !== undefined ? (d.endDate ? istMidnight(new Date(d.endDate)) : null) : existing.endDate,
    };
    assertCadence(merged);

    const cadenceChanged =
      d.frequency !== undefined ||
      d.intervalDays !== undefined ||
      d.daysOfWeek !== undefined ||
      d.dayOfMonth !== undefined ||
      d.startDate !== undefined;

    const today = istMidnight(new Date());
    const seedFrom = merged.startDate > today ? merged.startDate : today;
    const nextDeliveryDate = cadenceChanged
      ? firstDeliveryOnOrAfter(toCadence(merged), seedFrom)
      : existing.nextDeliveryDate;

    const sub = await prisma.subscription.update({
      where: { id: existing.id },
      data: {
        quantity: d.quantity ?? undefined,
        addressId: d.addressId ?? undefined,
        billing: d.billing ?? undefined,
        frequency: merged.frequency,
        intervalDays: merged.intervalDays,
        daysOfWeek: merged.daysOfWeek,
        dayOfMonth: merged.dayOfMonth,
        startDate: merged.startDate,
        endDate: merged.endDate,
        nextDeliveryDate,
      },
    });
    res.json({ success: true, data: serialize(sub) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/pause  {until?} ───────────────────────────────────────
// With `until` → a TEMPORARY pause that auto-resumes (status stays ACTIVE, pausedUntil set; the
// engine skips while pausedUntil is in the future). Without → an INDEFINITE pause (status=PAUSED).
const pauseSchema = z.object({ until: z.string().optional().nullable() });
router.post("/:id/pause", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const parsed = pauseSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const existing = await ownedSub(userId, req.params.id as string);
    if (existing.status === "CANCELLED") throw new ValidationError("Subscription is cancelled");

    const until = parsed.data.until ? istMidnight(new Date(parsed.data.until)) : null;
    const sub = await prisma.subscription.update({
      where: { id: existing.id },
      data: until ? { status: "ACTIVE", pausedUntil: until } : { status: "PAUSED", pausedUntil: null },
    });
    res.json({ success: true, data: serialize(sub) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/resume ────────────────────────────────────────────────
router.post("/:id/resume", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const existing = await ownedSub(userId, req.params.id as string);
    if (existing.status === "CANCELLED") throw new ValidationError("Subscription is cancelled");
    const today = istMidnight(new Date());
    const next = firstDeliveryOnOrAfter(toCadence(existing), today);
    const sub = await prisma.subscription.update({
      where: { id: existing.id },
      data: { status: "ACTIVE", pausedUntil: null, nextDeliveryDate: next },
    });
    res.json({ success: true, data: serialize(sub) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/skip-next  — advance the cursor one cycle ─────────────
router.post("/:id/skip-next", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const existing = await ownedSub(userId, req.params.id as string);
    if (existing.status === "CANCELLED") throw new ValidationError("Subscription is cancelled");
    const from = existing.nextDeliveryDate ? istMidnight(existing.nextDeliveryDate) : istMidnight(new Date());
    const next = computeNextDeliveryDate(toCadence(existing), from);
    const sub = await prisma.subscription.update({
      where: { id: existing.id },
      data: { nextDeliveryDate: next },
    });
    res.json({ success: true, data: serialize(sub) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE /:id  — cancel (kept for history) ────────────────────────
router.delete("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const existing = await ownedSub(userId, req.params.id as string);
    await prisma.subscription.update({ where: { id: existing.id }, data: { status: "CANCELLED" } });
    res.json({ success: true, data: { id: existing.id, status: "CANCELLED" } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /:id/upcoming  — next ~10 delivery dates ────────────────────
router.get("/:id/upcoming", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const existing = await ownedSub(userId, req.params.id as string);
    const dates = upcomingDates({ ...toCadence(existing), nextDeliveryDate: existing.nextDeliveryDate }, 10);
    res.json({ success: true, data: dates.map((d) => d.toISOString()) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
