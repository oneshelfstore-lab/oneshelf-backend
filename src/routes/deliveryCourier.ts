import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, AppError } from "../lib/errors.js";
import { haversineKm } from "../lib/distance.js";
import { firebaseAuthMiddleware, requireAppRole, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { riderKycGate, assertCanTakeWork } from "./delivery.js";
import { recordCourierEvent, dispatchToRiders } from "../services/courier.js";
import { checkHandoff, afterWrongCode, refusalMessage } from "../services/courierHandoff.js";
import { notifyCourierCustomer, notifyCourierFailed } from "../services/fcmNotifier.js";

/**
 * The rider's side of a courier booking (COURIER_PLAN.md §3): pool → accept → pickup (code + geofence)
 * → deliver (code + geofence) | failed | release.
 *
 * Mounted at /api/app/delivery/courier — DELIVERY riders only (the owner has no reason to be here in
 * P2; owner override lands with the P3 board). Same KYC gate and same "can this rider take work" rules
 * as the shop feed, so an unverified or licence-expired rider is stopped identically.
 *
 * ⚠️ A rider is shown only what the next step needs. The drop address and recipient's number appear
 * ONLY after the pickup code has verified (a rider who never collects the parcel never learns where
 * it was going), and the two codes are NEVER returned to a rider — they exist to be read off the
 * customer's / recipient's screen.
 */
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("DELIVERY") as any);
router.use(riderKycGate as any);

/** Pool radius for the feed; a rider with no known position sees everything (matches the push rule). */
const POOL_RADIUS_KM = 15;
/** One parcel at a time: it keeps hand-offs simple and the evidence trail unambiguous. */
const MAX_ACTIVE_JOBS = 1;

const fixSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).optional(),
});

type RiderBooking = Awaited<ReturnType<typeof loadMine>>;

async function loadMine(id: string, riderId: string) {
  return prisma.courierBooking.findFirst({ where: { id, riderId }, include: { secret: true, customer: { select: { name: true } } } });
}

/** What a rider may see. No codes, ever; the drop only once the parcel is in their hands. */
function riderView(b: {
  id: string; number: string; status: string; speed: string; parcelType: string; weightBand: string; declaredValueBand: string;
  distanceKm: unknown; acceptedAt: Date | null;
  pickupLat: unknown; pickupLng: unknown; pickupAddress: string; pickupContactName: string; pickupContactPhone: string;
  dropLat: unknown; dropLng: unknown; dropAddress: string; dropLandmark: string | null; recipientName: string; recipientPhone: string;
}, mine: boolean) {
  const n = (d: unknown) => Number(d);
  const collected = b.status === "PICKED_UP";
  return {
    id: b.id,
    number: b.number,
    status: b.status,
    speed: b.speed,
    parcelType: b.parcelType,
    weightBand: b.weightBand,
    declaredValueBand: b.declaredValueBand,
    distanceKm: n(b.distanceKm),
    acceptedAt: b.acceptedAt,
    pickup: {
      lat: n(b.pickupLat), lng: n(b.pickupLng), address: b.pickupAddress,
      // The sender's name/number are for a rider who has taken the job (to find the doorstep), not the pool.
      contactName: mine ? b.pickupContactName : null,
      contactPhone: mine ? b.pickupContactPhone : null,
    },
    drop: collected
      ? { lat: n(b.dropLat), lng: n(b.dropLng), address: b.dropAddress, landmark: b.dropLandmark, recipientName: b.recipientName, recipientPhone: b.recipientPhone }
      : null,
  };
}

// ─── GET / — the pool + my active job ────────────────────────────────
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const me = req.appUser!.id;
    const IST = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST);
    const monthStart = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1) - IST);
    const [rider, mine, pool, monthDelivered, rated] = await Promise.all([
      prisma.user.findUnique({ where: { id: me }, select: { lastLat: true, lastLng: true, lastSeenAt: true, isAvailableForDelivery: true } }),
      prisma.courierBooking.findMany({ where: { riderId: me, status: { in: ["ASSIGNED", "PICKED_UP"] } }, orderBy: { acceptedAt: "asc" } }),
      prisma.courierBooking.findMany({ where: { status: "SEARCHING", riderId: null, paymentStatus: "PAID" }, orderBy: { createdAt: "asc" }, take: 30 }),
      prisma.courierBooking.count({ where: { riderId: me, status: "DELIVERED", deliveredAt: { gte: monthStart } } }),
      prisma.courierBooking.aggregate({ where: { riderId: me, ratingStars: { not: null } }, _avg: { ratingStars: true }, _count: { ratingStars: true } }),
    ]);
    const hasFix = rider?.lastLat != null && rider?.lastLng != null && rider.lastSeenAt != null && Date.now() - rider.lastSeenAt.getTime() < 30 * 60_000;
    const near = pool.filter((b) => !hasFix || haversineKm(Number(rider!.lastLat), Number(rider!.lastLng), Number(b.pickupLat), Number(b.pickupLng)) <= POOL_RADIUS_KM);
    res.json({
      success: true,
      data: {
        // An offline rider sees their own job (they must be able to finish it) but not new work.
        available: rider?.isAvailableForDelivery ? near.map((b) => riderView(b, false)) : [],
        mine: mine.map((b) => riderView(b, true)),
        // Their own courier month. A rating average is withheld until there are 3 — one bad day is not a rating.
        stats: {
          monthDelivered,
          ratingCount: rated._count.ratingStars,
          avgRating: rated._count.ratingStars >= 3 && rated._avg.ratingStars != null ? Math.round(rated._avg.ratingStars * 10) / 10 : null,
        },
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/accept ────────────────────────────────────────────────
router.post("/:id/accept", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const me = req.appUser!.id;
    const id = String(req.params.id);
    const fix = fixSchema.partial().safeParse(req.body ?? {});
    await assertCanTakeWork(me);

    const active = await prisma.courierBooking.count({ where: { riderId: me, status: { in: ["ASSIGNED", "PICKED_UP"] } } });
    if (active >= MAX_ACTIVE_JOBS) throw new ValidationError("Finish your current courier delivery before taking another.");

    const claimed = await prisma.$transaction(async (tx) => {
      // The claim IS the guard: two riders tapping Accept together — exactly one row matches.
      const upd = await tx.courierBooking.updateMany({
        where: { id, status: "SEARCHING", riderId: null, paymentStatus: "PAID" },
        data: { status: "ASSIGNED", riderId: me, acceptedAt: new Date() },
      });
      if (upd.count === 0) return false;
      await recordCourierEvent(tx, {
        bookingId: id, type: "RIDER_ASSIGNED", actorType: "DELIVERY", actorId: me,
        lat: fix.success ? fix.data.lat : null, lng: fix.success ? fix.data.lng : null,
      });
      return true;
    });
    if (!claimed) throw new ValidationError("This pickup was just taken by another delivery partner.");

    const b = await loadMine(id, me);
    notifyCourierCustomer(b!.customerId, {
      bookingId: id, number: b!.number,
      title: "Delivery partner assigned",
      body: `${req.appUser!.name} is on the way to pick up your parcel.`,
    }).catch((e: unknown) => console.error("[background task failed]", e));
    res.json({ success: true, data: riderView(b!, true) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/release — hand an un-collected job back to the pool ───
router.post("/:id/release", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const me = req.appUser!.id;
    const id = String(req.params.id);
    // Only before pickup: once the parcel is in the rider's hands it can't just be dropped back in the pool.
    const released = await prisma.$transaction(async (tx) => {
      const upd = await tx.courierBooking.updateMany({
        where: { id, riderId: me, status: "ASSIGNED" },
        data: { status: "SEARCHING", riderId: null, acceptedAt: null },
      });
      if (upd.count === 0) return false;
      await recordCourierEvent(tx, { bookingId: id, type: "RIDER_RELEASED", actorType: "DELIVERY", actorId: me });
      return true;
    });
    if (!released) throw new ValidationError("You can only hand back a job before collecting the parcel.");
    const b = await prisma.courierBooking.findUnique({ where: { id }, select: { id: true, number: true, pickupLat: true, pickupLng: true } });
    if (b) dispatchToRiders(b);
    res.json({ success: true, data: { released: true } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── The two handoffs share one shape ────────────────────────────────
// photoPath = a Storage OBJECT PATH the rider's app uploaded (camera-only, courier_photos/{firebaseUid}/…).
const handoffSchema = fixSchema.extend({
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
  photoPath: z.string().max(300).optional(),
});

async function handoff(
  req: FirebaseAuthRequest,
  res: Response,
  kind: "PICKUP" | "DELIVERY",
) {
  const me = req.appUser!.id;
  const id = String(req.params.id);
  const p = handoffSchema.safeParse(req.body);
  if (!p.success) throw new ValidationError(p.error.errors[0]?.message ?? "Invalid request", p.error.errors);

  // A photo path is accepted only under THIS rider's own folder, so a rider can't attach someone else's upload.
  const photoPath = p.data.photoPath?.trim() || undefined;
  if (photoPath && !photoPath.startsWith(`courier_photos/${req.appUser!.firebaseUid}/`)) {
    throw new ValidationError("That photo doesn't belong to you.");
  }
  const from = kind === "PICKUP" ? "ASSIGNED" : "PICKED_UP";
  const b = await loadMine(id, me);
  if (!b) throw new NotFoundError("Courier booking", id);
  if (b.status !== from || !b.secret) {
    throw new ValidationError(kind === "PICKUP" ? "This parcel is not waiting for pickup." : "This parcel is not out for delivery.");
  }

  const s = b.secret;
  const target = kind === "PICKUP"
    ? { lat: Number(b.pickupLat), lng: Number(b.pickupLng) }
    : { lat: Number(b.dropLat), lng: Number(b.dropLng) };
  const now = Date.now();
  const result = checkHandoff({
    expectedCode: kind === "PICKUP" ? s.pickupOtp : s.deliveryOtp,
    code: p.data.code,
    attempts: kind === "PICKUP" ? s.pickupAttempts : s.deliveryAttempts,
    lockedUntil: kind === "PICKUP" ? s.pickupLockedUntil : s.deliveryLockedUntil,
    now,
    fix: { lat: p.data.lat, lng: p.data.lng, accuracyM: p.data.accuracyM },
    target,
  });

  const evidence = { lat: p.data.lat, lng: p.data.lng, accuracyM: p.data.accuracyM ?? null, actorType: "DELIVERY" as const, actorId: me };

  if (!result.ok) {
    // Every refusal is logged: a rider repeatedly "verifying" from the wrong place is exactly the
    // pattern a later dispute (or the P4 anomaly flags) needs to be able to see.
    await recordCourierEvent(null, {
      bookingId: id, type: `${kind}_REFUSED`, ...evidence,
      metadata: { reason: result.reason, distanceM: result.distanceM ?? null },
    });
    if (result.reason === "WRONG_CODE") {
      const next = afterWrongCode(kind === "PICKUP" ? s.pickupAttempts : s.deliveryAttempts, now);
      await prisma.courierSecret.update({
        where: { bookingId: id },
        data: kind === "PICKUP"
          ? { pickupAttempts: next.attempts, pickupLockedUntil: next.lockedUntil }
          : { deliveryAttempts: next.attempts, deliveryLockedUntil: next.lockedUntil },
      });
      // The message is built from the state BEFORE this miss, so a lock that this very miss triggers is told plainly.
      if (next.lockedUntil) throw new AppError(429, "CODE_LOCKED", refusalMessage({ ok: false, reason: "LOCKED", retryInSec: Math.ceil((next.lockedUntil.getTime() - now) / 1000) }));
    }
    throw new AppError(result.reason === "LOCKED" ? 429 : 400, `HANDOFF_${result.reason}`, refusalMessage(result));
  }

  const to = kind === "PICKUP" ? "PICKED_UP" : "DELIVERED";
  const done = await prisma.$transaction(async (tx) => {
    // CAS again inside the transaction — the read above and this write are not atomic.
    const upd = await tx.courierBooking.updateMany({
      where: { id, riderId: me, status: from },
      data: kind === "PICKUP"
        ? { status: to, pickedUpAt: new Date(), ...(photoPath ? { pickupPhotoPath: photoPath } : {}) }
        : { status: to, deliveredAt: new Date(), ...(photoPath ? { dropPhotoPath: photoPath } : {}) },
    });
    if (upd.count === 0) return false;
    await tx.courierSecret.update({
      where: { bookingId: id },
      data: kind === "PICKUP" ? { pickupAttempts: 0, pickupLockedUntil: null } : { deliveryAttempts: 0, deliveryLockedUntil: null },
    });
    await recordCourierEvent(tx, { bookingId: id, type: to, ...evidence, metadata: { distanceM: result.distanceM, codeVerified: true, photo: !!photoPath } });
    return true;
  });
  if (!done) throw new ValidationError("This booking just changed. Refresh and try again.");

  notifyCourierCustomer(b.customerId, {
    bookingId: id, number: b.number,
    title: kind === "PICKUP" ? "Parcel picked up" : "Parcel delivered",
    body: kind === "PICKUP" ? "Your parcel is on its way to the recipient." : `${b.number} has been delivered.`,
  }).catch((e: unknown) => console.error("[background task failed]", e));

  const fresh = (await loadMine(id, me)) as NonNullable<RiderBooking>;
  res.json({ success: true, data: riderView(fresh, true) });
}

router.post("/:id/pickup", async (req: FirebaseAuthRequest, res: Response) => {
  try { await handoff(req, res, "PICKUP"); } catch (e) { sendError(res, e); }
});

router.post("/:id/deliver", async (req: FirebaseAuthRequest, res: Response) => {
  try { await handoff(req, res, "DELIVERY"); } catch (e) { sendError(res, e); }
});

// ─── POST /:id/failed — could not hand it over ───────────────────────
// ⚠️ Keep this list in step with the Kotlin one in CourierRiderScreen (a key on one side only 400s
// with a rider standing at a door — same warning as delivery.ts FAILURE_REASONS).
const FAILURE_REASONS: Record<string, string> = {
  RECIPIENT_UNAVAILABLE: "Recipient not available",
  WRONG_ADDRESS: "Address could not be found",
  RECIPIENT_REFUSED: "Recipient refused the parcel",
  UNREACHABLE: "Recipient not reachable by phone",
};

router.post("/:id/failed", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const me = req.appUser!.id;
    const id = String(req.params.id);
    const p = fixSchema.partial().extend({ reason: z.enum(Object.keys(FAILURE_REASONS) as [string, ...string[]]) }).safeParse(req.body);
    if (!p.success) throw new ValidationError("Choose a reason", p.error.errors);

    const b = await loadMine(id, me);
    if (!b) throw new NotFoundError("Courier booking", id);

    // ⚠️ The parcel stays with the rider and the booking goes FAILED, NOT back to the pool: they have
    // the goods, and pooling it would let a second rider "accept" a parcel that is in the first one's bag.
    // No automatic refund — whether the sender is refunded, and the parcel returned, is the owner's call (P3).
    const ok = await prisma.$transaction(async (tx) => {
      const upd = await tx.courierBooking.updateMany({ where: { id, riderId: me, status: "PICKED_UP" }, data: { status: "FAILED", cancelReason: FAILURE_REASONS[p.data.reason] } });
      if (upd.count === 0) return false;
      await recordCourierEvent(tx, {
        bookingId: id, type: "FAILED", actorType: "DELIVERY", actorId: me,
        lat: p.data.lat ?? null, lng: p.data.lng ?? null, metadata: { reason: p.data.reason },
      });
      return true;
    });
    if (!ok) throw new ValidationError("Only a parcel you have collected can be marked as failed.");

    notifyCourierCustomer(b.customerId, {
      bookingId: id, number: b.number, title: "Delivery could not be completed", body: `${FAILURE_REASONS[p.data.reason]}. The store will contact you.`,
    }).catch((e: unknown) => console.error("[background task failed]", e));
    notifyCourierFailed({ bookingId: id, number: b.number, reason: FAILURE_REASONS[p.data.reason] })
      .catch((e: unknown) => console.error("[background task failed]", e));
    res.json({ success: true, data: { status: "FAILED" } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
