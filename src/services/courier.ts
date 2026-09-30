import prisma from "../lib/prisma.js";
import { memoCache } from "../lib/httpCache.js";
import { AppError, ValidationError } from "../lib/errors.js";
import { generateOtp } from "../lib/otp.js";
import { getCurrentFinancialYear } from "./invoiceNumbering.js";
import {
  checkCourierEligibility,
  computeCourierPrice,
  parseOr,
  courierSlabsSchema,
  weightSurchargeSchema,
  DEFAULT_COURIER_SLABS,
  DEFAULT_WEIGHT_SURCHARGE,
  SPEED_WINDOW,
  SPEEDS,
  type CourierPricingConfig,
  type Ineligible,
  type Point,
  type Speed,
  type WeightBand,
} from "./courierPricing.js";
import {
  createRazorpayOrder,
  fetchCapturedPaymentForOrder,
  isRazorpayConfigured,
  refundPayment,
} from "./razorpay.js";

/**
 * Courier bookings — config, numbering, the evidence log, payment confirmation, cancel/refund and
 * the sweeper. See COURIER_PLAN.md. Everything money-shaped here is idempotent: three feeders
 * (the app's /pay, the Razorpay webhook, reconcile-on-view) converge on `confirmCourierPayment`.
 */

// ─── Config ──────────────────────────────────────────────────────────

export interface CourierConfig extends CourierPricingConfig {
  enabled: boolean;
  searchTimeoutMin: number;
}

const CONFIG_KEY = "courier:config";

export function bustCourierConfig() {
  memoCache.bust(CONFIG_KEY);
}

export async function resolveCourierConfig(): Promise<CourierConfig> {
  return memoCache.get(CONFIG_KEY, 30_000, async () => {
    const c = await prisma.storeConfig.findFirst();
    const radius = c?.courierPickupRadiusKm ?? (c?.deliveryRadius != null ? Number(c.deliveryRadius) : null);
    return {
      enabled: c?.courierEnabled ?? false,
      maxKm: c?.courierMaxKm ?? 10,
      slabs: parseOr(courierSlabsSchema, c?.courierSlabs, DEFAULT_COURIER_SLABS, "courierSlabs"),
      weightSurcharge: parseOr(weightSurchargeSchema, c?.courierWeightSurcharge, DEFAULT_WEIGHT_SURCHARGE, "courierWeightSurcharge"),
      expressFee: c?.courierExpressFee ?? 17,
      platformFee: c?.courierPlatformFee ?? 3,
      storeLat: c?.storeLat != null ? Number(c.storeLat) : null,
      storeLng: c?.storeLng != null ? Number(c.storeLng) : null,
      pickupRadiusKm: radius,
      searchTimeoutMin: c?.courierSearchTimeoutMin ?? 10,
    };
  });
}

// ─── Quote ───────────────────────────────────────────────────────────

const INELIGIBLE_MESSAGE: Record<Ineligible, string> = {
  SAME_LOCATION: "Pickup and drop-off are the same place.",
  DROP_TOO_FAR: "This destination is outside our local delivery range.",
  PICKUP_OUT_OF_AREA: "Courier isn't available at your pickup location yet.",
};

export async function quoteCourier(pickup: Point, drop: Point, weightBand: WeightBand) {
  const cfg = await resolveCourierConfig();
  if (!cfg.enabled) throw new ValidationError("Courier isn't available yet.");
  const elig = checkCourierEligibility(pickup, drop, cfg);
  if (!elig.eligible) {
    return { eligible: false as const, reason: elig.reason, message: INELIGIBLE_MESSAGE[elig.reason], distanceKm: elig.distanceKm, maxKm: cfg.maxKm };
  }
  return {
    eligible: true as const,
    distanceKm: elig.distanceKm,
    maxKm: cfg.maxKm,
    speeds: SPEEDS.map((speed) => ({
      speed,
      window: SPEED_WINDOW[speed],
      ...computeCourierPrice(elig.distanceKm, weightBand, speed, cfg),
    })),
  };
}

// ─── Numbering ───────────────────────────────────────────────────────

/** CR/2627/00001 — own InvoiceCounter prefix, same serializable-counter shape as getNextOrderNumber. */
export async function getNextCourierNumber(): Promise<string> {
  const fy = getCurrentFinancialYear();
  const prefix = "CR";
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.invoiceCounter.findUnique({ where: { prefix_financialYear: { prefix, financialYear: fy } } });
      const next = (existing?.lastNumber ?? 0) + 1;
      if (existing) {
        await tx.invoiceCounter.update({ where: { prefix_financialYear: { prefix, financialYear: fy } }, data: { lastNumber: next } });
      } else {
        await tx.invoiceCounter.create({ data: { prefix, financialYear: fy, lastNumber: next } });
      }
      return `${prefix}/${fy}/${String(next).padStart(5, "0")}`;
    },
    { isolationLevel: "Serializable" },
  );
}

// ─── Evidence log ────────────────────────────────────────────────────

type EventClient = { courierEvent: { create: (args: any) => Promise<unknown> } };

export interface CourierEventInput {
  bookingId: string;
  type: string;
  actorType: "CUSTOMER" | "DELIVERY" | "OWNER" | "SYSTEM";
  actorId?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Appends one evidence row. Pass the tx client when the event belongs to a state change so they
 * commit together. Never updates or deletes — a correction is a new event.
 * Throws inside a tx on purpose: a state change with no audit row must roll back.
 */
export async function recordCourierEvent(client: EventClient | null, e: CourierEventInput): Promise<void> {
  await (client ?? prisma).courierEvent.create({
    data: {
      bookingId: e.bookingId,
      type: e.type,
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      lat: e.lat ?? null,
      lng: e.lng ?? null,
      accuracyM: e.accuracyM ?? null,
      metadata: (e.metadata ?? undefined) as any,
    },
  });
}

// ─── Booking ─────────────────────────────────────────────────────────

export interface BookingInput {
  pickup: Point & { address: string; contactName?: string; contactPhone?: string };
  drop: Point & { address: string; landmark?: string; recipientName: string; recipientPhone: string };
  parcelType: string;
  weightBand: WeightBand;
  declaredValueBand: string;
  speed: Speed;
  useWallet: boolean;
  idempotencyKey?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const bookingViewSelect = {
  secret: true,
  rider: { select: { id: true, name: true } },
  events: { orderBy: { createdAt: "asc" as const }, select: { type: true, createdAt: true } },
};

export async function createCourierBooking(
  user: { id: string; name: string; phone: string | null },
  input: BookingInput,
) {
  const cfg = await resolveCourierConfig();
  if (!cfg.enabled) throw new ValidationError("Courier isn't available yet.");

  // Replay: same customer + key returns the booking already made (double-tap / retried request).
  if (input.idempotencyKey) {
    const prior = await prisma.courierBooking.findUnique({
      where: { customerId_idempotencyKey: { customerId: user.id, idempotencyKey: input.idempotencyKey } },
    });
    if (prior) return prior;
  }

  const elig = checkCourierEligibility(input.pickup, input.drop, cfg);
  if (!elig.eligible) throw new ValidationError(INELIGIBLE_MESSAGE[elig.reason]);
  const price = computeCourierPrice(elig.distanceKm, input.weightBand, input.speed, cfg);

  const contactPhone = input.pickup.contactPhone ?? user.phone;
  if (!contactPhone) throw new ValidationError("Add a phone number to your profile before booking a courier.");

  let wallet = 0;
  if (input.useWallet) {
    const u = await prisma.user.findUnique({ where: { id: user.id }, select: { walletBalance: true } });
    wallet = round2(Math.min(Number(u?.walletBalance ?? 0), price.total));
  }
  const due = round2(price.total - wallet);
  // Checked BEFORE anything is written: refusing after the wallet was debited would need an unwind.
  if (due > 0 && !isRazorpayConfigured()) throw new ValidationError("Online payment is unavailable right now. Please try again later.");

  const number = await getNextCourierNumber();
  const paidUpFront = due === 0;

  let booking;
  try {
    booking = await prisma.$transaction(async (tx) => {
      const b = await tx.courierBooking.create({
        data: {
          number,
          customerId: user.id,
          status: paidUpFront ? "SEARCHING" : "PENDING_PAYMENT",
          paymentStatus: paidUpFront ? "PAID" : "PENDING",
          pickupLat: input.pickup.lat,
          pickupLng: input.pickup.lng,
          pickupAddress: input.pickup.address,
          pickupContactName: input.pickup.contactName ?? user.name,
          pickupContactPhone: contactPhone,
          dropLat: input.drop.lat,
          dropLng: input.drop.lng,
          dropAddress: input.drop.address,
          dropLandmark: input.drop.landmark ?? null,
          recipientName: input.drop.recipientName,
          recipientPhone: input.drop.recipientPhone,
          parcelType: input.parcelType,
          weightBand: input.weightBand,
          declaredValueBand: input.declaredValueBand,
          speed: input.speed,
          prohibitedAckAt: new Date(),
          distanceKm: elig.distanceKm,
          deliveryFee: price.deliveryFee,
          platformFee: price.platformFee,
          total: price.total,
          walletApplied: wallet,
          idempotencyKey: input.idempotencyKey ?? null,
          secret: { create: { pickupOtp: generateOtp(), deliveryOtp: generateOtp() } },
        },
      });

      if (wallet > 0) {
        // Guarded decrement — the balance check and the debit are one statement, so two racing
        // bookings can't both spend the same credit.
        const dec = await tx.user.updateMany({
          where: { id: user.id, walletBalance: { gte: wallet } },
          data: { walletBalance: { decrement: wallet } },
        });
        if (dec.count === 0) throw new ValidationError("Your wallet balance changed. Please try again.");
        const fresh = await tx.user.findUnique({ where: { id: user.id }, select: { walletBalance: true } });
        await tx.walletTransaction.create({
          data: { userId: user.id, amount: -wallet, type: "ORDER_DEBIT", balanceAfter: fresh!.walletBalance, orderId: b.id, note: `Courier ${number}` },
        });
      }

      await recordCourierEvent(tx, { bookingId: b.id, type: "BOOKED", actorType: "CUSTOMER", actorId: user.id, lat: input.pickup.lat, lng: input.pickup.lng });
      if (paidUpFront) await recordCourierEvent(tx, { bookingId: b.id, type: "PAYMENT_CONFIRMED", actorType: "SYSTEM", metadata: { method: "WALLET" } });
      return b;
    });
  } catch (e: any) {
    // Lost an idempotency race to a parallel identical request — hand back the winner.
    if (e?.code === "P2002" && input.idempotencyKey) {
      const prior = await prisma.courierBooking.findUnique({
        where: { customerId_idempotencyKey: { customerId: user.id, idempotencyKey: input.idempotencyKey } },
      });
      if (prior) return prior;
    }
    throw e;
  }

  if (due > 0) {
    try {
      const rp = await createRazorpayOrder(Math.round(due * 100), number);
      return await prisma.courierBooking.update({ where: { id: booking.id }, data: { razorpayOrderId: rp.id } });
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "courier razorpay order failed", bookingId: booking.id, err: String(err) }));
      // Nothing was charged; unwind the booking (returns any wallet credit) rather than leave it dangling.
      await cancelCourierBooking(booking.id, { actorType: "SYSTEM", reason: "Could not start payment", allowedFrom: ["PENDING_PAYMENT"] });
      throw new AppError(502, "PAYMENT_UNAVAILABLE", "Couldn't start the payment. Please try again.");
    }
  }
  return booking;
}

// ─── Payment confirmation (ONE idempotent path for /pay, webhook, reconcile) ──

/**
 * A captured Razorpay payment for this booking. PENDING_PAYMENT → SEARCHING. If the booking was
 * already cancelled (payment arrived after the expiry sweeper gave up) the money is refunded — never kept.
 * Returns true when THIS call flipped it to paid.
 */
export async function confirmCourierPayment(bookingId: string, razorpayPaymentId: string): Promise<boolean> {
  const flipped = await prisma.$transaction(async (tx) => {
    const upd = await tx.courierBooking.updateMany({
      where: { id: bookingId, status: "PENDING_PAYMENT", paymentStatus: "PENDING" },
      data: { status: "SEARCHING", paymentStatus: "PAID", razorpayPaymentId },
    });
    if (upd.count === 0) return false;
    await recordCourierEvent(tx, { bookingId, type: "PAYMENT_CONFIRMED", actorType: "SYSTEM", metadata: { method: "RAZORPAY", paymentId: razorpayPaymentId } });
    return true;
  });
  if (flipped) return true;

  // Not flippable. The only case that needs action is money captured for a booking we already cancelled.
  const claimed = await prisma.courierBooking.updateMany({
    where: { id: bookingId, status: "CANCELLED", paymentStatus: "PENDING" },
    data: { paymentStatus: "REFUND_INITIATED", razorpayPaymentId },
  });
  if (claimed.count === 1) await refundRazorpayPortion(bookingId, razorpayPaymentId);
  return false;
}

/** Asks Razorpay whether an unpaid booking was in fact paid (killed app / missed webhook). Safe to repeat. */
export async function reconcileCourierPayment(bookingId: string): Promise<void> {
  const b = await prisma.courierBooking.findUnique({
    where: { id: bookingId },
    select: { paymentStatus: true, razorpayOrderId: true },
  });
  if (!b?.razorpayOrderId || b.paymentStatus !== "PENDING" || !isRazorpayConfigured()) return;
  try {
    const captured = await fetchCapturedPaymentForOrder(b.razorpayOrderId);
    if (captured) await confirmCourierPayment(bookingId, captured.id);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "courier reconcile failed", bookingId, err: String(e) }));
  }
}

// ─── Cancel + refund ─────────────────────────────────────────────────

/** Gateway refund of the Razorpay-paid part (total − wallet). Caller has already claimed REFUND_INITIATED. */
async function refundRazorpayPortion(bookingId: string, razorpayPaymentId: string) {
  const b = await prisma.courierBooking.findUnique({ where: { id: bookingId }, select: { total: true, walletApplied: true } });
  const due = round2(Number(b?.total ?? 0) - Number(b?.walletApplied ?? 0));
  try {
    // ⚠️ Gateway call OUTSIDE any transaction — never hold row locks across a network call.
    if (due > 0) await refundPayment(razorpayPaymentId, Math.round(due * 100));
    await prisma.courierBooking.update({ where: { id: bookingId }, data: { paymentStatus: "REFUNDED" } });
  } catch (e) {
    // Left at REFUND_INITIATED so the owner can see and retry it; never silently dropped.
    console.error(JSON.stringify({ level: "error", msg: "courier refund failed", bookingId, err: String(e) }));
  }
}

/** Returns store credit spent on a cancelled booking. Unique (orderId,type) makes a repeat a no-op. */
async function refundCourierWallet(bookingId: string) {
  const b = await prisma.courierBooking.findUnique({
    where: { id: bookingId },
    select: { customerId: true, walletApplied: true, status: true, number: true },
  });
  const amt = Number(b?.walletApplied ?? 0);
  if (!b || b.status !== "CANCELLED" || amt <= 0) return;
  try {
    await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: b.customerId }, data: { walletBalance: { increment: amt } }, select: { walletBalance: true } });
      await tx.walletTransaction.create({
        data: { userId: b.customerId, amount: amt, type: "ORDER_REFUND", balanceAfter: u.walletBalance, orderId: bookingId, note: `Refund — courier ${b.number} cancelled` },
      });
    });
  } catch (e: any) {
    if (e?.code !== "P2002") console.error(JSON.stringify({ level: "error", msg: "courier wallet refund failed", bookingId, err: String(e) }));
  }
}

/**
 * Compare-and-swap to CANCELLED from an allowed set of states, then settle the money. Exactly one
 * caller wins the CAS, so the customer tapping Cancel while the sweeper runs can't double-refund.
 * `customerId` scopes the CAS to the caller's own booking.
 */
export async function cancelCourierBooking(
  bookingId: string,
  opts: {
    actorType: "CUSTOMER" | "OWNER" | "SYSTEM";
    actorId?: string;
    customerId?: string;
    reason: string;
    allowedFrom: Array<"PENDING_PAYMENT" | "SEARCHING" | "ASSIGNED" | "PICKED_UP">;
  },
): Promise<"CANCELLED" | "NOT_CANCELLABLE"> {
  const won = await prisma.$transaction(async (tx) => {
    const upd = await tx.courierBooking.updateMany({
      where: { id: bookingId, status: { in: opts.allowedFrom }, ...(opts.customerId ? { customerId: opts.customerId } : {}) },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: opts.reason },
    });
    if (upd.count === 0) return false;
    await recordCourierEvent(tx, { bookingId, type: "CANCELLED", actorType: opts.actorType, actorId: opts.actorId, metadata: { reason: opts.reason } });
    return true;
  });
  if (!won) return "NOT_CANCELLABLE";

  await refundCourierWallet(bookingId);

  const b = await prisma.courierBooking.findUnique({
    where: { id: bookingId },
    select: { paymentStatus: true, razorpayPaymentId: true, total: true, walletApplied: true },
  });
  if (b?.paymentStatus === "PAID") {
    const claimed = await prisma.courierBooking.updateMany({ where: { id: bookingId, paymentStatus: "PAID" }, data: { paymentStatus: "REFUND_INITIATED" } });
    if (claimed.count === 1) {
      if (b.razorpayPaymentId) await refundRazorpayPortion(bookingId, b.razorpayPaymentId);
      else await prisma.courierBooking.update({ where: { id: bookingId }, data: { paymentStatus: "REFUNDED" } }); // wallet-only
    }
  }
  return "CANCELLED";
}

// ─── Customer-facing shape ───────────────────────────────────────────

/** Events the customer's timeline may show. Everything else in the log is internal evidence. */
const CUSTOMER_EVENTS = new Set(["BOOKED", "PAYMENT_CONFIRMED", "RIDER_ASSIGNED", "PICKED_UP", "DELIVERED", "CANCELLED", "FAILED"]);

type BookingWithView = Awaited<ReturnType<typeof loadBookingView>>;

export async function loadBookingView(where: { id: string; customerId: string }) {
  return prisma.courierBooking.findFirst({ where, include: bookingViewSelect });
}

export function shapeBooking(b: NonNullable<BookingWithView>) {
  const n = (d: unknown) => Number(d);
  return {
    id: b.id,
    number: b.number,
    status: b.status,
    speed: b.speed,
    parcelType: b.parcelType,
    weightBand: b.weightBand,
    declaredValueBand: b.declaredValueBand,
    pickup: { lat: n(b.pickupLat), lng: n(b.pickupLng), address: b.pickupAddress, contactName: b.pickupContactName },
    drop: { lat: n(b.dropLat), lng: n(b.dropLng), address: b.dropAddress, landmark: b.dropLandmark, recipientName: b.recipientName, recipientPhone: b.recipientPhone },
    distanceKm: n(b.distanceKm),
    deliveryFee: n(b.deliveryFee),
    platformFee: n(b.platformFee),
    total: n(b.total),
    walletApplied: n(b.walletApplied),
    amountDue: round2(n(b.total) - n(b.walletApplied)),
    paymentStatus: b.paymentStatus,
    razorpayOrderId: b.paymentStatus === "PENDING" ? b.razorpayOrderId : null,
    riderName: b.rider?.name ?? null,
    // Each code is shown only when its handoff is the next thing to happen — hidden any earlier so
    // it can't be screenshotted or shared long before it's needed.
    pickupCode: b.status === "ASSIGNED" ? (b.secret?.pickupOtp ?? null) : null,
    deliveryCode: b.status === "PICKED_UP" ? (b.secret?.deliveryOtp ?? null) : null,
    cancelReason: b.cancelReason,
    canCancel: b.status === "PENDING_PAYMENT" || b.status === "SEARCHING",
    createdAt: b.createdAt,
    timeline: b.events.filter((e) => CUSTOMER_EVENTS.has(e.type)).map((e) => ({ type: e.type, at: e.createdAt })),
  };
}

// ─── Sweeper ─────────────────────────────────────────────────────────

const UNPAID_EXPIRY_MIN = 20;

/** Cancels unpaid bookings (after a last Razorpay check) and paid ones no rider accepted in time. */
export async function expireStaleCourierBookings(): Promise<number> {
  const cfg = await resolveCourierConfig();
  let n = 0;

  const unpaid = await prisma.courierBooking.findMany({
    where: { status: "PENDING_PAYMENT", createdAt: { lt: new Date(Date.now() - UNPAID_EXPIRY_MIN * 60_000) } },
    select: { id: true },
  });
  for (const { id } of unpaid) {
    try {
      await reconcileCourierPayment(id); // a captured-but-unconfirmed payment must not be cancelled
      const r = await cancelCourierBooking(id, { actorType: "SYSTEM", reason: "Payment not completed", allowedFrom: ["PENDING_PAYMENT"] });
      if (r === "CANCELLED") n++;
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "courier unpaid expiry failed", id, err: String(e) }));
    }
  }

  // SEARCHING is entered at payment confirmation and nothing else touches the row while it waits,
  // so updatedAt is "when the search began".
  const searching = await prisma.courierBooking.findMany({
    where: { status: "SEARCHING", updatedAt: { lt: new Date(Date.now() - cfg.searchTimeoutMin * 60_000) } },
    select: { id: true },
  });
  for (const { id } of searching) {
    try {
      const r = await cancelCourierBooking(id, { actorType: "SYSTEM", reason: "No delivery partner was available", allowedFrom: ["SEARCHING"] });
      if (r === "CANCELLED") n++;
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "courier search expiry failed", id, err: String(e) }));
    }
  }

  if (n > 0) console.log(JSON.stringify({ level: "info", msg: "expired courier bookings", count: n }));
  return n;
}

export function startCourierSweeper(intervalMs = 2 * 60 * 1000): void {
  const timer = setInterval(() => {
    expireStaleCourierBookings().catch((e) =>
      console.error(JSON.stringify({ level: "error", msg: "courier sweep crashed", err: String(e) })),
    );
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
