import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, NotFoundError, ValidationError, ConflictError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { shapeComplaint } from "./appUser.js";

// Owner complaint inbox. Mounted at /api/app/owner/complaints.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// GET /api/app/owner/complaints?page=&limit=&role= → complaints + filer name/phone/role (newest
// first), paginated — the inbox grows for as long as the store is in business, so an unbounded
// findMany here would re-fetch every complaint ever filed on every screen open. Same page/limit/
// pagination envelope convention as GET /api/app/orders. `role` (DELIVERY|CUSTOMER|...) lets the
// owner isolate rider-raised issues from customer complaints — same data, different lens.
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const ROLES = ["OWNER", "ACCOUNTANT", "BILLING_CLERK", "VIEWER", "CUSTOMER", "DELIVERY", "SELLER"] as const;
    const roleParam = typeof req.query.role === "string" ? req.query.role.toUpperCase() : undefined;
    const role = (ROLES as readonly string[]).includes(roleParam ?? "") ? (roleParam as (typeof ROLES)[number]) : undefined;

    const [complaints, total] = await Promise.all([
      prisma.complaint.findMany({
        where: role ? { user: { role } } : undefined,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { name: true, phone: true, role: true } } },
      }),
      prisma.complaint.count({ where: role ? { user: { role } } : undefined }),
    ]);

    res.json({
      success: true,
      data: complaints.map((c) => shapeComplaint(c)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/owner/complaints/:id/resolve → mark resolved
router.post("/:id/resolve", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const existing = await prisma.complaint.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Complaint", id);

    const updated = await prisma.complaint.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
      include: { user: { select: { name: true, phone: true, role: true } } },
    });
    res.json({ success: true, data: shapeComplaint(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/owner/complaints/:id/refund { mode: "WALLET"|"EXTERNAL", amount } → the owner
// actually moves the money for a seller-flagged (or self-initiated) return. WALLET credits the
// customer's store-credit wallet right now (reuses the same signed-ledger shape refundWalletOnCancel
// already uses); EXTERNAL just records that the owner already paid the customer outside the app
// (bank transfer/UPI — same "manual ledger, no payout API" precedent as SellerPayout). Idempotent:
// a complaint can only be refunded once (refundedAt gates it).
const refundSchema = z.object({
  mode: z.enum(["WALLET", "EXTERNAL"]),
  amount: z.number().positive().max(100000),
});

router.post("/:id/refund", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = refundSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid refund request", parsed.error.errors);
    const { mode, amount } = parsed.data;

    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) throw new NotFoundError("Complaint", id);
    if (complaint.refundedAt) throw new ConflictError("This complaint has already been refunded.");
    if (mode === "WALLET" && !complaint.orderId) {
      throw new ValidationError("A wallet refund needs an order to credit against — this complaint has no linked order.");
    }

    if (mode === "WALLET") {
      await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: complaint.userId },
          data: { walletBalance: { increment: amount } },
          select: { walletBalance: true },
        });
        await tx.walletTransaction.create({
          data: {
            userId: complaint.userId,
            amount,
            type: "ORDER_REFUND",
            balanceAfter: u.walletBalance,
            orderId: complaint.orderId,
            note: `Return refund — complaint ${complaint.id}`,
          },
        });
        await tx.complaint.update({
          where: { id },
          data: { status: "RESOLVED", resolvedAt: new Date(), refundedAmount: amount, refundMode: mode, refundedAt: new Date() },
        });
      });
    } else {
      // EXTERNAL — the money already moved outside the app; just record it for the books.
      await prisma.complaint.update({
        where: { id },
        data: { status: "RESOLVED", resolvedAt: new Date(), refundedAmount: amount, refundMode: mode, refundedAt: new Date() },
      });
    }

    const updated = await prisma.complaint.findUnique({ where: { id }, include: { user: { select: { name: true, phone: true, role: true } } } });
    res.json({ success: true, data: shapeComplaint(updated!) });
  } catch (e: any) {
    // P2002 on WalletTransaction's @@unique([orderId, type]) — this order already has an
    // ORDER_REFUND row (e.g. it was separately cancelled-and-refunded) — surface a clear error
    // rather than silently double-crediting or silently no-op'ing an explicit owner action.
    if (e?.code === "P2002") {
      return sendError(res, new ConflictError("This order already has a refund on record — check the wallet ledger before refunding again."));
    }
    sendError(res, e);
  }
});

export default router;
