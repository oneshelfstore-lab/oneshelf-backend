import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, AppError } from "../lib/errors.js";
import { firebaseAuthMiddleware, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { phoneSchema } from "../validators/index.js";
import { verifyPaymentSignature } from "../services/razorpay.js";
import {
  PARCEL_TYPES,
  WEIGHT_BANDS,
  VALUE_BANDS,
  SPEEDS,
} from "../services/courierPricing.js";
import {
  quoteCourier,
  createCourierBooking,
  confirmCourierPayment,
  reconcileCourierPayment,
  cancelCourierBooking,
  loadBookingView,
  shapeBooking,
} from "../services/courier.js";

/**
 * Customer-side courier (COURIER_PLAN.md). Riders' routes come in P2 under /delivery/courier.
 * Everything money- or eligibility-shaped is recomputed on the server; the app only sends intent.
 */
const router = Router();
router.use(firebaseAuthMiddleware as any);

// "+91 98765 43210" / "098765-43210" → "9876543210", then validated as an Indian mobile.
const phone = z.preprocess(
  (v) => (typeof v === "string" ? v.replace(/\D/g, "").slice(-10) : v),
  phoneSchema,
);
const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

// ─── POST /quote — eligibility + both speeds' prices ─────────────────
// Called the moment a destination is picked, so ">10 km" is shown before the form is filled.
router.post("/quote", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const p = z
      .object({ pickup: point, drop: point, weightBand: z.enum(WEIGHT_BANDS).default("UPTO_1") })
      .safeParse(req.body);
    if (!p.success) throw new ValidationError("Invalid quote request", p.error.errors);
    res.json({ success: true, data: await quoteCourier(p.data.pickup, p.data.drop, p.data.weightBand) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST / — book ───────────────────────────────────────────────────
const bookSchema = z.object({
  pickup: point.extend({
    address: z.string().trim().min(3).max(300),
    contactName: z.string().trim().min(1).max(100).optional(),
    contactPhone: phone.optional(),
  }),
  drop: point.extend({
    address: z.string().trim().min(3).max(300),
    landmark: z.string().trim().max(120).optional(),
    recipientName: z.string().trim().min(1).max(100),
    recipientPhone: phone,
  }),
  parcelType: z.enum(PARCEL_TYPES),
  weightBand: z.enum(WEIGHT_BANDS),
  declaredValueBand: z.enum(VALUE_BANDS),
  speed: z.enum(SPEEDS),
  // Must be literally true — booking is the customer's declaration that nothing prohibited is inside.
  prohibitedAck: z.literal(true),
  useWallet: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const p = bookSchema.safeParse(req.body);
    if (!p.success) throw new ValidationError("Invalid booking", p.error.errors);
    const { prohibitedAck: _ack, ...input } = p.data;
    const booking = await createCourierBooking(req.appUser!, input);
    const view = await loadBookingView({ id: booking.id, customerId: req.appUser!.id });
    res.json({ success: true, data: shapeBooking(view!) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET / — my bookings ─────────────────────────────────────────────
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const rows = await prisma.courierBooking.findMany({
      where: { customerId: req.appUser!.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { secret: true, rider: { select: { id: true, name: true } }, events: { orderBy: { createdAt: "asc" }, select: { type: true, createdAt: true } } },
    });
    res.json({ success: true, data: rows.map(shapeBooking) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /:id ────────────────────────────────────────────────────────
router.get("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const view = await loadBookingView({ id, customerId: req.appUser!.id });
    if (!view) throw new NotFoundError("Courier booking", id);
    res.json({ success: true, data: shapeBooking(view) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/pay — Razorpay verification (fast path; webhook + reconcile are the backstops) ──
const paySchema = z.object({ razorpayPaymentId: z.string().min(1), razorpaySignature: z.string().min(1) });

router.post("/:id/pay", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const p = paySchema.safeParse(req.body);
    if (!p.success) throw new ValidationError("Invalid payment data", p.error.errors);
    const id = String(req.params.id);
    const b = await prisma.courierBooking.findFirst({
      where: { id, customerId: req.appUser!.id },
      select: { id: true, razorpayOrderId: true, paymentStatus: true },
    });
    if (!b) throw new NotFoundError("Courier booking", id);
    if (!b.razorpayOrderId) throw new ValidationError("This booking has no pending online payment");

    // Already confirmed (the webhook usually wins the race) — a real payment succeeded, so this is success, not an error.
    if (b.paymentStatus !== "PAID") {
      if (!verifyPaymentSignature(b.razorpayOrderId, p.data.razorpayPaymentId, p.data.razorpaySignature)) {
        throw new AppError(400, "PAYMENT_INVALID", "Payment signature verification failed");
      }
      await confirmCourierPayment(b.id, p.data.razorpayPaymentId);
    }
    const view = await loadBookingView({ id, customerId: req.appUser!.id });
    res.json({ success: true, data: shapeBooking(view!) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/reconcile — recover a stranded payment (app reopen) ───
router.post("/:id/reconcile", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const view = await loadBookingView({ id, customerId: req.appUser!.id });
    if (!view) throw new NotFoundError("Courier booking", id);
    await reconcileCourierPayment(id);
    const fresh = await loadBookingView({ id, customerId: req.appUser!.id });
    res.json({ success: true, data: shapeBooking(fresh!) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/cancel — free until a rider accepts; after that it goes through support ──
router.post("/:id/cancel", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const owned = await prisma.courierBooking.findFirst({ where: { id, customerId: req.appUser!.id }, select: { id: true } });
    if (!owned) throw new NotFoundError("Courier booking", id);

    const r = await cancelCourierBooking(id, {
      actorType: "CUSTOMER",
      actorId: req.appUser!.id,
      customerId: req.appUser!.id,
      reason: "Cancelled by customer",
      allowedFrom: ["PENDING_PAYMENT", "SEARCHING"],
    });
    if (r === "NOT_CANCELLABLE") {
      // Retry of an already-cancelled booking reads as success; anything later needs the store.
      const cur = await prisma.courierBooking.findUnique({ where: { id }, select: { status: true } });
      if (cur?.status !== "CANCELLED") {
        throw new AppError(409, "NOT_CANCELLABLE", "A delivery partner has already accepted this. Please contact support to cancel.");
      }
    }
    const view = await loadBookingView({ id, customerId: req.appUser!.id });
    res.json({ success: true, data: shapeBooking(view!) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
