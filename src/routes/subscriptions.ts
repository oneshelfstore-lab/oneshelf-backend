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
  approveHeldRun,
  quoteRoutine,
  type CadenceLike,
} from "../services/subscriptionEngine.js";
import { DELIVERY_SLOTS, DELIVERY_SLOT_IDS } from "../data/deliverySlots.js";
import { isLooseType } from "../services/routinePlan.js";
import { toAppFormat } from "../utils/looseUnitConverter.js";
import { detectRecurring, type Purchase } from "../services/routineIntel.js";

const router = Router();
router.use(firebaseAuthMiddleware as any);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_DAY = 24 * 60 * 60 * 1000;

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
// The API still accepts every cadence (MONTHLY/CUSTOM) — released app builds offer them. The NEW app only
// offers Daily + Weekly; hiding the rest is a client concern, not something the server should break.
const cadenceShape = {
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "CUSTOM"]),
  intervalDays: z.number().int().min(1).max(90).optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional().default([]),
  dayOfMonth: z.number().int().min(1).max(28).optional().nullable(),
  startDate: z.string().min(1),
  endDate: z.string().optional().nullable(),
};

const itemInput = z.object({
  variantId: z.string().min(1),
  quantity: z.number().positive().max(50), // sane cap — a routine is not a bulk order
  // What to do if it can't be delivered today. Absent = leave as is (SKIP for a new item).
  substitution: z.enum(["SKIP", "SIMILAR"]).optional(),
});

const ceilingShape = {
  priceCeilingType: z.enum(["ABSOLUTE", "PERCENT"]).optional(),
  priceCeilingValue: z.number().min(0).max(100000).optional(),
};

// Old app builds POST a single product ({variantId, quantity}); fold that into a one-item routine.
export function legacyToItems(body: unknown): unknown {
  if (body && typeof body === "object" && !("items" in body) && "variantId" in body) {
    const b = body as { variantId: unknown; quantity: unknown };
    return { ...body, items: [{ variantId: b.variantId, quantity: b.quantity }] };
  }
  return body;
}

const createSchema = z.preprocess(
  legacyToItems,
  z.object({
    name: z.string().trim().min(1).max(60).optional(),
    items: z.array(itemInput).min(1).max(20),
    addressId: z.string().min(1),
    // Prepaid-first (no postpaid): WALLET = prepaid wallet auto-debit; COD = pay-on-delivery daily cash;
    // AUTOPAY = UPI mandate (inert until a live Razorpay merchant + a set-up mandate exist).
    billing: z.enum(["COD", "WALLET", "AUTOPAY"]).default("WALLET"),
    deliverySlotId: z.enum(DELIVERY_SLOT_IDS).default("MORNING"),
    // "Leave it at the door" — copied onto every generated order.
    deliveryNote: z.string().trim().max(200).optional(),
    ...ceilingShape,
    ...cadenceShape,
  }),
);

const updateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  // Full replacement of the routine's lines. Legacy single-product clients send `quantity` instead.
  items: z.array(itemInput).min(1).max(20).optional(),
  quantity: z.number().positive().max(50).optional(),
  addressId: z.string().min(1).optional(),
  billing: z.enum(["COD", "WALLET", "AUTOPAY"]).optional(),
  deliverySlotId: z.enum(DELIVERY_SLOT_IDS).optional(),
  deliveryNote: z.string().trim().max(200).optional().nullable(), // "" or null clears it
  ...ceilingShape,
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
    throw new ValidationError("Pick at least one weekday for a weekly routine");
  }
  if (c.frequency === "MONTHLY" && (c.dayOfMonth == null || c.dayOfMonth < 1 || c.dayOfMonth > 28)) {
    throw new ValidationError("Pick a day of month (1–28) for a monthly routine");
  }
  if (c.frequency === "CUSTOM" && (c.intervalDays == null || c.intervalDays < 1)) {
    throw new ValidationError("Set an interval (every N days) for a custom routine");
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

function serializeItem(i: any) {
  return {
    ...i,
    quantity: Number(i.quantity),
    stepSize: i.stepSize == null ? null : Number(i.stepSize),
    unitPriceSnapshot: i.unitPriceSnapshot == null ? null : Number(i.unitPriceSnapshot),
  };
}

/**
 * A routine as the apps see it. `items` is the truth; the legacy single-product fields (variantId,
 * quantity, isLoose, stepSize, stepUnit, unitPriceSnapshot) are DERIVED from the first item so released
 * app builds — which only know one product per subscription — keep parsing and rendering it.
 * Legacy rows without items fall back to their own columns.
 */
export function serialize(sub: any) {
  const items = (sub.items ?? []).map(serializeItem);
  const first = items[0];
  return {
    ...sub,
    items,
    variantId: sub.variantId ?? first?.variantId ?? "",
    quantity: sub.quantity != null ? Number(sub.quantity) : (first?.quantity ?? 0),
    isLoose: first?.isLoose ?? sub.isLoose ?? false,
    stepSize: first ? first.stepSize : sub.stepSize == null ? null : Number(sub.stepSize),
    stepUnit: first ? first.stepUnit : (sub.stepUnit ?? null),
    unitPriceSnapshot: first ? first.unitPriceSnapshot : sub.unitPriceSnapshot == null ? null : Number(sub.unitPriceSnapshot),
    priceCeilingValue: sub.priceCeilingValue == null ? 30 : Number(sub.priceCeilingValue),
  };
}

// ─── GET /  — my routines ────────────────────────────────────────────
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const subs = await prisma.subscription.findMany({
      where: { customerId: req.appUser!.id, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
    res.json({ success: true, data: subs.map(serialize) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /slots  — the fixed delivery windows ────────────────────────
router.get("/slots", (_req: FirebaseAuthRequest, res: Response) => {
  res.json({ success: true, data: DELIVERY_SLOTS });
});

// ─── GET /suggestions  — "you keep buying these" → a ready-made routine ─────
// Looks at the customer's ordinary orders from the last 90 days for daily-need items (owner-flagged
// `isSubscribable`) they re-buy on a steady rhythm and aren't already in a routine. Returns ONE suggestion
// (one store, one schedule, predicted quantities) or `data: null`. Pure logic in services/routineIntel.ts.
router.get("/suggestions", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const since = new Date(Date.now() - 90 * MS_DAY);
    const [orders, house] = await Promise.all([
      prisma.order.findMany({
        where: { customerId: userId, subscriptionId: null, status: { not: "CANCELLED" }, createdAt: { gte: since } },
        select: { createdAt: true, items: { select: { variantId: true, quantity: true, sellerId: true } } },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      prisma.seller.findFirst({ where: { isHouse: true }, select: { id: true } }),
    ]);

    const rows: Purchase[] = [];
    for (const o of orders) {
      for (const it of o.items) {
        if (!it.variantId) continue;
        rows.push({ variantId: it.variantId, storeKey: it.sellerId ?? house?.id ?? "HOUSE", quantity: Number(it.quantity), at: o.createdAt });
      }
    }
    const ids = [...new Set(rows.map((r) => r.variantId))];
    if (ids.length === 0) return void res.json({ success: true, data: null });

    // Only things a routine can actually hold, and that aren't already in one of this customer's routines.
    const [variants, taken] = await Promise.all([
      prisma.productVariant.findMany({
        where: { id: { in: ids }, isActive: true, product: { isSubscribable: true } },
        include: { product: { select: { name: true, imageUrls: true } } },
      }),
      prisma.subscriptionItem.findMany({
        where: { variantId: { in: ids }, subscription: { customerId: userId, status: { in: ["ACTIVE", "PAUSED"] } } },
        select: { variantId: true },
      }),
    ]);
    const byId = new Map(variants.map((v) => [v.id, v]));
    const takenIds = new Set(taken.map((t) => t.variantId));
    const found = detectRecurring(rows.filter((r) => byId.has(r.variantId) && !takenIds.has(r.variantId)));
    if (!found) return void res.json({ success: true, data: null });

    res.json({
      success: true,
      data: {
        cadence: found.cadence,
        daysOfWeek: found.daysOfWeek,
        items: found.items.slice(0, 6).map((i) => {
          const v = byId.get(i.variantId)!;
          return {
            variantId: i.variantId,
            productName: v.product.name,
            imageUrl: v.product.imageUrls?.[0] ?? null,
            quantity: i.quantity,
            timesBought: i.timesBought,
            everyDays: i.everyDays,
          };
        }),
      },
    });
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

// ─── routine validation shared by create + edit ──────────────────────
type RoutineItemInput = { variantId: string; quantity: number; substitution?: "SKIP" | "SIMILAR" };

/**
 * Loads + validates the variants a routine would contain: every one exists, is active, is owner-flagged
 * `isSubscribable` (the daily-need gate), appears once, belongs to ONE store, and isn't already in another
 * live routine of this customer (two routines for the same product = double deliveries).
 */
async function loadRoutineVariants(userId: string, items: RoutineItemInput[], excludeSubscriptionId?: string) {
  const ids = items.map((i) => i.variantId);
  if (new Set(ids).size !== ids.length) throw new ValidationError("Each product can appear only once in a routine");

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: ids } },
    include: { product: { select: { name: true, productType: true, imageUrls: true, isSubscribable: true, sellerId: true } } },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  for (const id of ids) {
    const v = byId.get(id);
    if (!v || !v.isActive) throw new NotFoundError("Product", id);
    if (!v.product.isSubscribable) throw new ValidationError(`${v.product.name} can't be added to a routine.`);
  }

  // One store per routine (null seller == house).
  const house = await prisma.seller.findFirst({ where: { isHouse: true }, select: { id: true } });
  const stores = new Set(variants.map((v) => v.product.sellerId ?? house?.id ?? "HOUSE"));
  if (stores.size > 1) throw new ValidationError("A routine can include items from one store only.");

  const duplicate = await prisma.subscriptionItem.findFirst({
    where: {
      variantId: { in: ids },
      subscription: {
        customerId: userId,
        status: { in: ["ACTIVE", "PAUSED"] },
        ...(excludeSubscriptionId ? { id: { not: excludeSubscriptionId } } : {}),
      },
    },
    select: { productName: true },
  });
  if (duplicate) {
    throw new ValidationError(
      `${duplicate.productName} is already in one of your routines. Edit that routine instead of creating a new one.`,
    );
  }
  return byId;
}

type RoutineVariant = Awaited<ReturnType<typeof loadRoutineVariants>> extends Map<string, infer V> ? V : never;

function newItemData(v: RoutineVariant, quantity: number, substitution?: "SKIP" | "SIMILAR") {
  const isLoose = isLooseType(v.product.productType);
  return {
    variantId: v.id,
    substitution: substitution ?? "SKIP",
    productName: v.product.name,
    imageUrl: v.product.imageUrls?.[0] ?? null,
    quantity,
    isLoose,
    stepSize: isLoose ? v.packageSize : null,
    stepUnit: isLoose ? v.packageUnit : null,
    // App-format unit price = what a run charges; the baseline for the price ceiling.
    unitPriceSnapshot: toAppFormat(v as never, isLoose).sellingPrice,
  };
}

// Core creation logic. Throws AppError/ValidationError/NotFoundError — callers catch per their needs.
export type CreateRoutineInput = z.infer<typeof createSchema>;

export async function createRoutineForUser(userId: string, d: CreateRoutineInput) {
  assertCadence(d);

  const config = await prisma.storeConfig.findFirst();
  if (config && !config.subscriptionsEnabled) {
    throw new AppError(403, "SUBSCRIPTIONS_DISABLED", "Routines are not available right now.");
  }

  const variants = await loadRoutineVariants(userId, d.items);

  const address = await prisma.address.findFirst({ where: { id: d.addressId, userId } });
  if (!address) throw new NotFoundError("Address", d.addressId);

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

  const itemRows = d.items.map((i) => newItemData(variants.get(i.variantId)!, i.quantity, i.substitution));
  const name = d.name ?? (itemRows.length === 1 ? itemRows[0]!.productName : "My routine");

  return prisma.subscription.create({
    data: {
      customerId: userId,
      name,
      productName: name, // legacy display title — what old app builds show
      imageUrl: itemRows[0]!.imageUrl,
      deliverySlotId: d.deliverySlotId,
      deliveryNote: d.deliveryNote || null,
      priceCeilingType: d.priceCeilingType ?? "ABSOLUTE",
      priceCeilingValue: d.priceCeilingValue ?? 30,
      frequency: d.frequency,
      intervalDays: d.intervalDays ?? null,
      daysOfWeek: d.daysOfWeek ?? [],
      dayOfMonth: d.dayOfMonth ?? null,
      addressId: d.addressId,
      billing: d.billing,
      startDate,
      endDate,
      nextDeliveryDate,
      items: { create: itemRows },
    },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
}

// Single-product shape kept for the combo fan-out (and any caller that still thinks in one product).
export async function createSubscriptionForUser(
  userId: string,
  d: Omit<CreateRoutineInput, "items" | "name" | "deliverySlotId"> & { variantId: string; quantity: number },
) {
  const { variantId, quantity, ...rest } = d;
  return createRoutineForUser(userId, { ...rest, deliverySlotId: "MORNING", items: [{ variantId, quantity }] });
}

// ─── POST /  — create a routine (also accepts the old single-product body) ────
router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid routine", parsed.error.errors);
    const sub = await createRoutineForUser(userId, parsed.data);
    res.status(201).json({ success: true, data: serialize(sub) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /from-combo/:comboId  — "Get every month" fan-out (combos Phase 5) ──────────
// One subscription PER checked combo line, sharing the same address/cadence/billing. No new
// Subscription shape — just calls createSubscriptionForUser in a loop. A line that can't be
// subscribed (not flagged isSubscribable, already has a live subscription, OOS…) is SKIPPED, not
// fatal — the customer still gets every line that worked, same "best effort" spirit as free-gift/
// substitution flows elsewhere in this app. The combo's own items aren't looked up here (the
// customer may have unchecked/rescaled some in the checklist) — the client sends exactly what it
// showed as selected.
const comboSubscribeSchema = z.object({
  addressId: z.string().min(1),
  billing: z.enum(["COD", "WALLET", "AUTOPAY"]).default("WALLET"),
  items: z
    .array(z.object({ variantId: z.string().min(1), quantity: z.number().positive().max(50) }))
    .min(1)
    .max(50),
  ...cadenceShape,
});

router.post("/from-combo/:comboId", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const parsed = comboSubscribeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid subscription request", parsed.error.errors);
    const d = parsed.data;
    assertCadence(d);

    const created: ReturnType<typeof serialize>[] = [];
    const skipped: { variantId: string; reason: string }[] = [];
    for (const item of d.items) {
      try {
        const sub = await createSubscriptionForUser(userId, {
          variantId: item.variantId,
          quantity: item.quantity,
          addressId: d.addressId,
          billing: d.billing,
          frequency: d.frequency,
          intervalDays: d.intervalDays,
          daysOfWeek: d.daysOfWeek,
          dayOfMonth: d.dayOfMonth,
          startDate: d.startDate,
          endDate: d.endDate,
        });
        created.push(serialize(sub));
      } catch (e: any) {
        skipped.push({ variantId: item.variantId, reason: e?.message ?? "Couldn't subscribe to this item." });
      }
    }
    res.status(201).json({ success: true, data: { created, skipped } });
  } catch (e) {
    sendError(res, e);
  }
});

// Helper: load a routine owned by the caller (or 404). Legacy single-product rows that never got a
// SubscriptionItem are materialised into one here, so every edit path can assume `items` is the truth.
async function ownedSub(userId: string, id: string) {
  const sub = await prisma.subscription.findFirst({
    where: { id, customerId: userId },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (!sub) throw new NotFoundError("Subscription", id);
  if (sub.items.length === 0 && sub.variantId && sub.quantity != null) {
    await prisma.subscriptionItem.create({
      data: {
        subscriptionId: sub.id,
        variantId: sub.variantId,
        productName: sub.productName,
        imageUrl: sub.imageUrl,
        quantity: sub.quantity,
        isLoose: sub.isLoose,
        stepSize: sub.stepSize,
        stepUnit: sub.stepUnit,
        // legacy loose snapshots were per-base-unit — leave null, the engine fills it on the next run
        unitPriceSnapshot: sub.isLoose ? null : sub.unitPriceSnapshot,
      },
    });
    return (await prisma.subscription.findFirst({
      where: { id, customerId: userId },
      include: { items: { orderBy: { createdAt: "asc" } } },
    }))!;
  }
  return sub;
}

// ─── PATCH /:id  — edit items / name / slot / ceiling / cadence / address / billing ──
router.patch("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid update", parsed.error.errors);
    const d = parsed.data;
    const existing = await ownedSub(userId, String(req.params.id));

    if (d.addressId) {
      const address = await prisma.address.findFirst({ where: { id: d.addressId, userId } });
      if (!address) throw new NotFoundError("Address", d.addressId);
    }

    // Old clients edit a single product's quantity; that only makes sense for a one-item routine.
    let itemInputs = d.items;
    if (!itemInputs && d.quantity !== undefined) {
      if (existing.items.length !== 1) throw new ValidationError("This routine has several items — edit the items instead.");
      itemInputs = [{ variantId: existing.items[0]!.variantId, quantity: d.quantity }];
    }
    const variants = itemInputs ? await loadRoutineVariants(userId, itemInputs, existing.id) : null;

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

    const sub = await prisma.$transaction(async (tx) => {
      if (itemInputs && variants) {
        // Full replacement: drop lines that are gone, update kept ones (their price baseline stays), add new.
        const keep = itemInputs.map((i) => i.variantId);
        await tx.subscriptionItem.deleteMany({ where: { subscriptionId: existing.id, variantId: { notIn: keep } } });
        for (const i of itemInputs) {
          const have = existing.items.find((e) => e.variantId === i.variantId);
          if (have) {
            await tx.subscriptionItem.update({ where: { id: have.id }, data: { quantity: i.quantity, ...(i.substitution ? { substitution: i.substitution } : {}) } });
          } else {
            await tx.subscriptionItem.create({
              data: { subscriptionId: existing.id, ...newItemData(variants.get(i.variantId)!, i.quantity, i.substitution) },
            });
          }
        }
      }
      return tx.subscription.update({
        where: { id: existing.id },
        data: {
          name: d.name ?? undefined,
          productName: d.name ?? undefined, // legacy display title mirrors the name for old app builds
          deliverySlotId: d.deliverySlotId ?? undefined,
          deliveryNote: d.deliveryNote === undefined ? undefined : d.deliveryNote || null,
          priceCeilingType: d.priceCeilingType ?? undefined,
          priceCeilingValue: d.priceCeilingValue ?? undefined,
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
        include: { items: { orderBy: { createdAt: "asc" } } },
      });
    });
    res.json({ success: true, data: serialize(sub) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /:id/quote  — what a run would deliver + cost RIGHT NOW (review sheet) ───
router.get("/:id/quote", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const quote = await quoteRoutine(String(req.params.id), req.appUser!.id);
    if (!quote) throw new NotFoundError("Subscription", String(req.params.id));
    res.json({ success: true, data: quote });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/approve-run  — customer OK's today's HELD run (price was over the ceiling) ───
router.post("/:id/approve-run", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const result = await approveHeldRun(String(req.params.id), req.appUser!.id);
    if (result === "not_held") throw new AppError(409, "NOT_HELD", "There is no held order to approve for this routine today.");
    res.json({ success: true, data: { result } });
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
    const existing = await ownedSub(userId, String(req.params.id));
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
    const existing = await ownedSub(userId, String(req.params.id));
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
    const existing = await ownedSub(userId, String(req.params.id));
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
    const existing = await ownedSub(userId, String(req.params.id));
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
    const existing = await ownedSub(userId, String(req.params.id));
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
    const existing = await ownedSub(userId, String(req.params.id));
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
    const existing = await ownedSub(userId, String(req.params.id));
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
    const existing = await ownedSub(userId, String(req.params.id));
    const date = istMidnight(new Date(String(req.params.date)));
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
