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
import { computeUnsettledCash, pendingSettlementFor } from "./delivery.js";

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

// ─── GET /api/app/owner/delivery-agents/cash — who is holding the store's money ─
// Declared BEFORE the "/:id/..." routes so "cash" is never read as a rider id.
//
// This view did not exist. CashSettlement was written by the rider and read by exactly one thing:
// the rider's own unsettled calculation. The owner had no way to answer "who owes me how much", and
// no way to confirm a handover — so a rider tapping Settle closed their own debt and no screen would
// ever have shown the money never arriving.
router.get("/cash", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const riders = await prisma.user.findMany({
      where: { role: "DELIVERY", isActive: true },
      select: { id: true, name: true, phone: true },
      orderBy: { name: "asc" },
    });

    const rows = await Promise.all(
      riders.map(async (r) => {
        const unsettled = await computeUnsettledCash(r.id);
        const pending = await pendingSettlementFor(r.id);
        return {
          riderId: r.id,
          name: r.name,
          phone: r.phone,
          // Collected and NOT yet confirmed back to the store.
          outstanding: unsettled.amount,
          outstandingOrderCount: unsettled.orderCount,
          lastSettledAt: unsettled.lastSettledAt,
          // A declaration waiting on the owner's acknowledgement — the actionable row.
          pendingSettlementId: pending?.id ?? null,
          pendingAmount: pending ? Number(pending.amount) : 0,
          pendingSince: pending?.settledAt ?? null,
        };
      }),
    );

    res.json({
      success: true,
      data: {
        riders: rows,
        totalOutstanding: rows.reduce((s, r) => s + r.outstanding, 0),
        awaitingConfirmation: rows.filter((r) => r.pendingSettlementId).length,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/owner/delivery-agents/settlements/:id/confirm — "I got the cash" ─
// The other half of the handover. ONLY this clears the rider's outstanding figure (and unblocks
// them if the cash-in-hand cap was holding them). Idempotent: re-confirming is a no-op success.
router.post("/settlements/:id/confirm", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const settlement = await prisma.cashSettlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundError("Cash settlement", id);
    if (settlement.status === "CONFIRMED") {
      return res.json({ success: true, data: { id, status: "CONFIRMED", alreadyConfirmed: true } });
    }
    const updated = await prisma.cashSettlement.update({
      where: { id },
      data: { status: "CONFIRMED", confirmedAt: new Date(), confirmedById: req.appUser!.id },
    });
    res.json({
      success: true,
      data: { id: updated.id, status: updated.status, amount: Number(updated.amount), confirmedAt: updated.confirmedAt },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/owner/delivery-agents/settlements/:id/reject — the cash didn't arrive ─
// Deletes the declaration so the rider's debt stays exactly where it was. Kept separate from
// confirm rather than a status flag: a rejected declaration carries no accounting meaning, and
// leaving REJECTED rows around would make the "one open declaration at a time" guard permanently
// block the rider from re-declaring.
router.post("/settlements/:id/reject", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const settlement = await prisma.cashSettlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundError("Cash settlement", id);
    if (settlement.status === "CONFIRMED") {
      throw new ValidationError("This handover is already confirmed — it can't be rejected.");
    }
    await prisma.cashSettlement.delete({ where: { id } });
    res.json({ success: true, data: { id, rejected: true } });
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

    const agent = await prisma.$transaction(async (tx) => {
      let user;
      if (existing) {
        // Promote to DELIVERY. Keep their real name if they already have one; otherwise
        // use the name the owner typed. Normalize the stored phone for clean matching.
        const keepName = existing.name && existing.name !== "App User" ? existing.name : name;
        user = await tx.user.update({
          where: { id: existing.id },
          data: { role: "DELIVERY", phone, name: keepName },
          select: { id: true, name: true, phone: true, firebaseUid: true, isAvailableForDelivery: true },
        });
      } else {
        // Pre-register: a DELIVERY row with no Firebase account yet. firebaseAuthMiddleware
        // links the account to this row by phone on the agent's first login.
        user = await tx.user.create({
          data: { name, phone, role: "DELIVERY", phoneVerified: false },
          select: { id: true, name: true, phone: true, firebaseUid: true, isAvailableForDelivery: true },
        });
      }

      // ⚠️ LOAD-BEARING — this is the ONLY thing putting a hand-added rider through KYC.
      // deliveryOnboarding.ts reads a MISSING DeliveryProfile as a virtual already-APPROVED
      // profile (a grandfather clause for riders who predate self-serve onboarding), and the
      // NavGraph gate lets those straight through to the dashboard. Without this create, THIS
      // route — the documented, primary way riders are added — kept minting new grandfathered
      // riders forever: live with no ID photo, no selfie, no DL/RC, no consent records, and
      // invisible to the owner's onboarding queue (which reads deliveryProfile rows, so there
      // was nothing to find). Same fix ownerSellers.ts POST / got for the identical hole.
      //
      // upsert with an empty `update` = create-if-missing: a rider who's already mid-onboarding
      // (or was previously approved, demoted via DELETE /:id, and is now being re-added) keeps
      // their existing status instead of being sent back to square one.
      await tx.deliveryProfile.upsert({
        where: { userId: user.id },
        create: { userId: user.id, onboardingStatus: "NOT_STARTED" },
        update: {},
      });
      return user;
    });

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

    // ⚠️ Demoting a rider is not free — dropping their role to CUSTOMER makes the entire delivery
    // router 403 for them, so anything they're mid-way through is ORPHANED: the order keeps pointing
    // at them, they can no longer touch it, and only the owner can force it closed. And their
    // outstanding COD becomes unqueryable, because the cash figure is only ever computed for riders.
    // Refuse until both are settled, naming the numbers. Mirrors getDeletionBlockers in
    // services/accountDeletion.ts, which already blocks a rider deleting their OWN account for the
    // same reason — the owner's remove button just never got the equivalent guard.
    const blockers: string[] = [];
    const activeOrders = await prisma.order.count({
      where: { deliveryBoyId: user.id, status: { in: ["PACKED", "OUT_FOR_DELIVERY"] } },
    });
    if (activeOrders > 0) {
      blockers.push(
        `${activeOrders} order${activeOrders === 1 ? "" : "s"} still out with them (reassign or complete ${activeOrders === 1 ? "it" : "them"} first)`,
      );
    }
    const cash = await computeUnsettledCash(user.id);
    if (cash.amount > 0) {
      blockers.push(`₹${Math.round(cash.amount)} of COD cash not yet settled`);
    }
    if (blockers.length > 0) {
      throw new ValidationError(`Can't remove ${user.name} yet — ${blockers.join(" and ")}.`);
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
