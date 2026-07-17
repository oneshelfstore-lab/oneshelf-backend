import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { istMonthKey } from "../services/referralRewards.js";

// Owner-managed delivery staff. Mounted at /api/app/owner/delivery-agents.
// A "delivery agent" is just a User with role = DELIVERY. The owner registers one by
// PHONE (no IDs): we promote an existing user by phone, or pre-create a DELIVERY row
// that the auth middleware links to on the agent's first phone-OTP login.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// Bare-10-digit normalization — mirrors firebaseAuthMiddleware's phone handling so
// matches succeed regardless of how the number was originally stored (+91 / 91 / raw).
function normalizePhone(input: string): string {
  return input.replace(/\D/g, "").slice(-10);
}

function shape(
  a: { id: string; name: string; phone: string | null; firebaseUid: string | null; isAvailableForDelivery: boolean; deliveryMonthlySalary?: unknown },
  paidThisMonth = false,
) {
  return {
    id: a.id,
    name: a.name,
    phone: a.phone,
    // true once they've actually logged in (Firebase account linked); false = pre-registered,
    // waiting for their first login. They can still be assigned to orders either way.
    active: !!a.firebaseUid,
    // The agent's own advisory on/off toggle (delivery dashboard). Advisory only — the owner
    // can still assign an "offline" boy; this just surfaces who's available right now.
    available: a.isAvailableForDelivery,
    // Payroll: the standing monthly salary + whether this (IST) month's salary is already recorded paid.
    monthlySalary: a.deliveryMonthlySalary != null ? Number(a.deliveryMonthlySalary) : 0,
    paidThisMonth,
  };
}

// ─── GET /api/app/owner/delivery-agents — list delivery boys ─────────
router.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const agents = await prisma.user.findMany({
      where: { role: "DELIVERY", isActive: true },
      select: { id: true, name: true, phone: true, firebaseUid: true, isAvailableForDelivery: true, deliveryMonthlySalary: true },
      orderBy: { name: "asc" },
    });
    // One lookup for "who's already been paid this IST month" instead of N per-rider queries.
    const currentMonth = istMonthKey(new Date());
    const paid = await prisma.riderSalaryPayment.findMany({
      where: { periodMonth: currentMonth, riderId: { in: agents.map((a) => a.id) } },
      select: { riderId: true },
    });
    const paidSet = new Set(paid.map((p) => p.riderId));
    res.json({ success: true, data: agents.map((a) => shape(a, paidSet.has(a.id))) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/owner/delivery-agents — register/promote by phone ─
const registerSchema = z.object({
  phone: z.string().min(8),
  name: z.string().min(1),
});

router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const phone = normalizePhone(parsed.data.phone);
    const name = parsed.data.name.trim();
    if (phone.length !== 10) throw new ValidationError("Enter a valid 10-digit phone number");

    // Find an existing user by any stored phone variant.
    const existing = await prisma.user.findFirst({
      where: { phone: { in: [phone, `+91${phone}`, `91${phone}`] } },
      orderBy: { createdAt: "asc" },
    });

    let agent;
    if (existing) {
      // Promote to DELIVERY. Keep their real name if they already have one; otherwise
      // use the name the owner typed. Normalize the stored phone for clean matching.
      const keepName = existing.name && existing.name !== "App User" ? existing.name : name;
      agent = await prisma.user.update({
        where: { id: existing.id },
        data: { role: "DELIVERY", phone, name: keepName },
        select: { id: true, name: true, phone: true, firebaseUid: true, isAvailableForDelivery: true },
      });
    } else {
      // Pre-register: a DELIVERY row with no Firebase account yet. firebaseAuthMiddleware
      // links the account to this row by phone on the agent's first login.
      agent = await prisma.user.create({
        data: { name, phone, role: "DELIVERY", phoneVerified: false },
        select: { id: true, name: true, phone: true, firebaseUid: true, isAvailableForDelivery: true },
      });
    }

    res.json({ success: true, data: shape(agent) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE /api/app/owner/delivery-agents/:id — demote to customer ──
// Soft "remove": flips the role back to CUSTOMER (keeps the account + their order
// history intact). They simply stop appearing in the delivery-agent list / picker.
router.delete("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== "DELIVERY") {
      throw new NotFoundError("Delivery agent", id);
    }
    await prisma.user.update({ where: { id: user.id }, data: { role: "CUSTOMER" } });
    res.json({ success: true, data: { id: user.id } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PATCH /api/app/owner/delivery-agents/:id/salary — set monthly salary ─
const salarySchema = z.object({ monthlySalary: z.number().min(0).max(1_000_000) });

router.patch("/:id/salary", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = salarySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid salary", parsed.error.errors);
    const rider = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!rider || rider.role !== "DELIVERY") throw new NotFoundError("Delivery agent", id);
    await prisma.user.update({ where: { id }, data: { deliveryMonthlySalary: parsed.data.monthlySalary } });
    res.json({ success: true, data: { id, monthlySalary: parsed.data.monthlySalary } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/owner/delivery-agents/:id/pay-salary — record a month's salary as paid ─
// Idempotent per (rider, month) via the @@unique — a second tap the same month is a no-op error, not
// a double payment. No real money moves; this is the owner's record they've paid the salary.
const paySalarySchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(), // defaults to current IST month
  amount: z.number().positive().max(1_000_000).optional(), // defaults to the standing monthlySalary
  note: z.string().max(500).optional(),
});

router.post("/:id/pay-salary", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = paySalarySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);

    const rider = await prisma.user.findUnique({ where: { id }, select: { role: true, deliveryMonthlySalary: true } });
    if (!rider || rider.role !== "DELIVERY") throw new NotFoundError("Delivery agent", id);

    const periodMonth = parsed.data.periodMonth ?? istMonthKey(new Date());
    const amount = parsed.data.amount ?? Number(rider.deliveryMonthlySalary);
    if (amount <= 0) throw new ValidationError("Set this rider's monthly salary first, or enter an amount to pay.");

    const existing = await prisma.riderSalaryPayment.findUnique({ where: { riderId_periodMonth: { riderId: id, periodMonth } } });
    if (existing) throw new ValidationError(`Salary for ${periodMonth} is already recorded as paid.`);

    const payment = await prisma.riderSalaryPayment.create({
      data: { riderId: id, periodMonth, amount, note: parsed.data.note ?? null },
    });
    res.json({ success: true, data: payment });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /api/app/owner/delivery-agents/:id/salary-history — recent salary payments ─
router.get("/:id/salary-history", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const payments = await prisma.riderSalaryPayment.findMany({
      where: { riderId: id },
      orderBy: { periodMonth: "desc" },
      take: 24,
    });
    res.json({ success: true, data: payments.map((p) => ({ ...p, amount: Number(p.amount) })) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
