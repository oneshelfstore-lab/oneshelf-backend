import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { notifyCommissionUpdate } from "../services/fcmNotifier.js";
import { sendError, ValidationError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import {
  listCommissionRequests,
  decideCommissionRequest,
  IMPACT_WINDOW_DAYS,
} from "../services/commissionNegotiation.js";

// The owner's commission-negotiation queue (runbook step 20). Mounted at
// /api/app/owner/commission-requests (Firebase auth + OWNER).
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

const STATUSES = ["PENDING", "APPROVED", "REJECTED", "COUNTERED", "WITHDRAWN"] as const;

// GET /?status=PENDING — every request, newest decisions last, PENDING first. Each row carries the
// rate as it stands, the ask, the product's volume over the impact window and what the change would
// cost — the owner should not have to go and look any of that up to answer.
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const status = String(req.query.status ?? "").trim().toUpperCase();
    if (status && !STATUSES.includes(status as never)) {
      throw new ValidationError(`status must be one of ${STATUSES.join(", ")}`);
    }
    const rows = await listCommissionRequests(status ? { status } : {});
    res.json({ success: true, data: { impactWindowDays: IMPACT_WINDOW_DAYS, requests: rows } });
  } catch (e) {
    sendError(res, e);
  }
});

const decideSchema = z.object({
  action: z.enum(["APPROVE", "COUNTER", "REJECT"]),
  // ⚠️ Bounded here AND by a database CHECK. This is the friendly message; the constraint is the
  // rule. A negative commission is the platform paying the seller a fee — see the migration.
  approvedPct: z.number().min(0).max(100).optional(),
  ownerNote: z.string().max(500).optional(),
});

// POST /:id/decide — approve, counter or reject. A counter is what makes this a negotiation rather
// than a switch: the owner offers a rate between the ask and the current one.
router.post("/:id/decide", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = decideSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid decision", parsed.error.errors);
    const data = await decideCommissionRequest({
      id: String(req.params.id ?? ""),
      action: parsed.data.action,
      approvedPct: parsed.data.approvedPct ?? null,
      ownerNote: parsed.data.ownerNote ?? null,
      decidedByUserId: req.appUser?.id ?? null,
    });
    // Tell the seller what the owner decided about their ask. Best-effort; a lookup hiccup must never
    // fail a decision that is already saved.
    prisma.commissionRequest
      .findUnique({
        where: { id: String(req.params.id ?? "") },
        select: { status: true, approvedPct: true, product: { select: { name: true } }, seller: { select: { ownerUserId: true } } },
      })
      .then((r) => {
        if (!r?.seller?.ownerUserId) return;
        const what = r.status === "REJECTED" ? "was declined" : r.status === "APPROVED" ? `was approved at ${Number(r.approvedPct)}%` : `got a counter-offer of ${Number(r.approvedPct)}%`;
        return notifyCommissionUpdate(r.seller.ownerUserId, "Commission request answered", `Your request for ${r.product.name} ${what}.`);
      })
      .catch((e: unknown) => console.error("[background task failed]", e));
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
