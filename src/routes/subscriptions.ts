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
  isValidDeliveryDay,
  type CadenceLike,
} from "../services/subscriptionEngine.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_DAY = 24 * 60 * 60 * 1000;

function isLooseType(t: string) {
  return t === "LOOSE" || t === "PRODUCE";
}

// The earliest IST-midnight date a customer can still edit (skip/un-skip), given the store's cutoff hour.
// Rule: to change a delivery you must act "the day before". So tomorrow is editable only until the cutoff
// hour today; after the cutoff, the earliest editable day is the day-after-tomorrow. Today is never editable.
function firstEditableDate(cutoffHour: number): Date {
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const hour = istNow.getUTCHours();
  const today = istMidnight(new Date());
  const daysAhead = hour < cutoffHour ? 1 : 2;
  return istMidnight(new Date(today.getTime() + daysAhead * MS_DAY));
}

async function getCutoffHour(): Promise<number> {
  const config = await prisma.storeConfig.findFirst({ select: { subscriptionCutoffHour: true } });
  return config?.subscriptionCutoffHour ?? 21;
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
  quantity: z.number().positive().max(50), // sane cap — a subscription isn't a bulk order
  addressId: z.string().min(1),
  // Prepaid-first (no postpaid): WALLET = prepaid wallet auto-debit; COD = pay-on-delivery daily cash;
  // AUTOPAY = UPI mandate (inert until a live Razorpay merchant + a set-up mandate exist).
  billing: z.enum(["COD", "WALLET", "AUTOPAY"]).default("WALLET"),
  ...cadenceShape,
});

const updateSchema = z.object({
  quantity: z.number().positive().max(50).optional(),
  addressId: z.string().min(1).optional(),
  billing: z.enum(["COD", "WALLET", "AUTOPAY"]).optional(),
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
    unitPriceSnapshot: sub.unitPriceSnapshot == null ? null : Number(sub.unitPriceSnapshot),
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

    // Guard against duplicate standing subscriptions for the same product: without this, subscribing
    // twice to the same variant (e.g. re-subscribing after forgetting an earlier one, or a double-tap)
    // leaves two ACTIVE rows — cancelling one still leaves the other generating daily orders, which
    // reads to the customer/owner as "I cancelled it but it keeps ordering." Editing an existing
    // subscription already goes through PATCH, so a second create for the same live subscription is
    // never intentional.
    const duplicate = await prisma.subscription.findFirst({
      where: { customerId: userId, variantId: d.variantId, status: { in: ["ACTIVE", "PAUSED"] } },
    });
    if (duplicate) {
      throw new ValidationError(
        "You already have a subscription for this product. Manage it from My Subscriptions instead of creating a new one.",
      );
    }

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
        unitPriceSnapshot: variant.sellingPrice, // price at subscribe (display + "price changed" hint)
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

// ─── GET /:id/calendar?month=YYYY-MM  — month grid for the calendar UI ─
// Every day of the month with flags: scheduled (a cadence delivery day), skipped (customer set an
// exception), locked (past / today / past-cutoff → not editable). The app renders dots + lock state.
router.get("/:id/calendar", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const existing = await ownedSub(userId, req.params.id as string);
    const cutoffHour = await getCutoffHour();
    const firstEditable = firstEditableDate(cutoffHour);

    const monthParam = (req.query.month as string | undefined) ?? "";
    const m = /^(\d{4})-(\d{2})$/.exec(monthParam);
    const nowIst = new Date(Date.now() + IST_OFFSET_MS);
    const year = m ? Number(m[1]) : nowIst.getUTCFullYear();
    const month = m ? Number(m[2]) : nowIst.getUTCMonth() + 1; // 1..12
    if (month < 1 || month > 12) throw new ValidationError("Invalid month");

    const cadence = toCadence(existing);
    const skips = await prisma.subscriptionException.findMany({
      where: { subscriptionId: existing.id, type: "SKIP" },
      select: { date: true },
    });
    const skipSet = new Set(skips.map((s) => istMidnight(s.date).getTime()));

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const day = istMidnight(new Date(Date.UTC(year, month - 1, d)));
      const withinRange =
        day.getTime() >= istMidnight(existing.startDate).getTime() &&
        (!existing.endDate || day.getTime() <= istMidnight(existing.endDate).getTime());
      const scheduled = withinRange && isValidDeliveryDay(cadence, day);
      const skipped = skipSet.has(day.getTime());
      const locked = day.getTime() < firstEditable.getTime();
      days.push({ date: day.toISOString(), scheduled, skipped, locked });
    }

    res.json({
      success: true,
      data: { month: `${year}-${String(month).padStart(2, "0")}`, cutoffHour, days },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/skip-date  {date}  — skip one delivery from the calendar ─
const skipDateSchema = z.object({ date: z.string().min(1) });
router.post("/:id/skip-date", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const existing = await ownedSub(userId, req.params.id as string);
    if (existing.status === "CANCELLED") throw new ValidationError("Subscription is cancelled");
    const parsed = skipDateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);

    const date = istMidnight(new Date(parsed.data.date));
    if (isNaN(date.getTime())) throw new ValidationError("Invalid date");
    const cutoffHour = await getCutoffHour();
    if (date.getTime() < firstEditableDate(cutoffHour).getTime()) {
      throw new ValidationError(
        `Cutoff passed for that date. Changes must be made before ${cutoffHour}:00 the day before.`,
      );
    }

    await prisma.subscriptionException.upsert({
      where: { subscriptionId_date: { subscriptionId: existing.id, date } },
      create: { subscriptionId: existing.id, date, type: "SKIP" },
      update: { type: "SKIP" },
    });
    res.json({ success: true, data: { date: date.toISOString(), skipped: true } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE /:id/skip-date/:date  — un-skip (restore) a delivery ─────
router.delete("/:id/skip-date/:date", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const existing = await ownedSub(userId, req.params.id as string);
    const date = istMidnight(new Date(req.params.date as string));
    if (isNaN(date.getTime())) throw new ValidationError("Invalid date");
    const cutoffHour = await getCutoffHour();
    if (date.getTime() < firstEditableDate(cutoffHour).getTime()) {
      throw new ValidationError(
        `Cutoff passed for that date. Changes must be made before ${cutoffHour}:00 the day before.`,
      );
    }

    await prisma.subscriptionException.deleteMany({
      where: { subscriptionId: existing.id, date },
    });
    res.json({ success: true, data: { date: date.toISOString(), skipped: false } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
