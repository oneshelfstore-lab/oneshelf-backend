import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// Owner queue for referral commission payouts (Firebase auth + OWNER). Mirrors ownerSellers.ts's
// payout list — a manual-ledger settlement: the owner sends the money by bank transfer outside the
// app, then marks it paid here. No automated payout API (same reasoning that already ruled it out
// for SellerPayout).
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// GET /api/app/owner/referral-payouts?status=PENDING|PAID
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const payouts = await prisma.referralPayout.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ status: "asc" }, { periodMonth: "desc" }],
      take: 200,
      include: { referrer: { select: { name: true, phone: true } } },
    });
    res.json({
      success: true,
      data: payouts.map((p) => ({
        id: p.id,
        referrerName: p.referrer.name,
        referrerPhone: p.referrer.phone,
        periodMonth: p.periodMonth,
        amount: Number(p.amount),
        status: p.status,
        method: p.method,
        bankAccountName: p.bankAccountName,
        bankAccountNumber: p.bankAccountNumber,
        bankIfsc: p.bankIfsc,
        paidAt: p.paidAt ? p.paidAt.getTime() : null,
        createdAt: p.createdAt.getTime(),
      })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// GET /api/app/owner/referral-payouts/outstanding — live "who we owe how much" before any
// request/grouping: each referrer's un-grouped (payoutId=null) commission, biggest first.
router.get("/outstanding", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const grouped = await prisma.referralCommission.groupBy({
      by: ["referrerId"],
      where: { payoutId: null },
      _sum: { amount: true },
      _count: { orderId: true },
    });
    const referrers = await prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.referrerId) } },
      select: { id: true, name: true, phone: true, referralBankAccountNumber: true },
    });
    const byId = new Map(referrers.map((u) => [u.id, u]));
    const rows = grouped
      .map((g) => {
        const u = byId.get(g.referrerId);
        return {
          referrerId: g.referrerId,
          referrerName: u?.name ?? "",
          referrerPhone: u?.phone ?? null,
          amount: Number(g._sum.amount ?? 0),
          orders: g._count.orderId,
          hasBankDetails: Boolean(u?.referralBankAccountNumber),
        };
      })
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    res.json({ success: true, data: rows });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/owner/referral-payouts/:id/mark-paid — owner confirms they sent the money.
router.post("/:id/mark-paid", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const payout = await prisma.referralPayout.findUnique({ where: { id } });
    if (!payout) throw new NotFoundError("ReferralPayout", id);
    if (payout.status === "PAID") throw new ValidationError("Already marked paid");

    const updated = await prisma.referralPayout.update({
      where: { id },
      data: { status: "PAID", paidAt: new Date() },
    });
    res.json({ success: true, data: { id: updated.id, status: updated.status, paidAt: updated.paidAt!.getTime() } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
