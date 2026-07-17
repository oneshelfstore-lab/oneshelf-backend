import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, NotFoundError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { shapeComplaint } from "./appUser.js";

// Seller-scoped view of complaints tied to THEIR orders — a seller previously had no visibility
// into complaints at all (ownerComplaints.ts was owner-only). Scoped via SubOrder.sellerId, since
// a Complaint only links to a plain orderId, not a seller. Mounted at /api/app/seller/complaints.
//   GET  /                → complaints on orders this seller had a slice of
//   POST /:id/flag-return  → recommend a refund amount for the owner to review + actually pay out
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

async function ownOrderIds(sellerId: string): Promise<string[]> {
  const rows = await prisma.subOrder.findMany({ where: { sellerId }, select: { orderId: true }, distinct: ["orderId"] });
  return rows.map((r) => r.orderId);
}

router.get("/", async (req: SellerRequest, res: Response) => {
  try {
    const orderIds = await ownOrderIds(req.sellerId!);
    const complaints = await prisma.complaint.findMany({
      where: { orderId: { in: orderIds } },
      orderBy: { createdAt: "desc" },
      include: { user: { select: { name: true, phone: true } } },
    });
    res.json({ success: true, data: complaints.map((c) => shapeComplaint(c)) });
  } catch (e) {
    sendError(res, e);
  }
});

const flagReturnSchema = z.object({
  suggestedRefundAmount: z.number().positive().max(100000),
  note: z.string().max(500).optional(),
});

router.post("/:id/flag-return", async (req: SellerRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = flagReturnSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid return flag", parsed.error.errors);

    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) throw new NotFoundError("Complaint", id);
    // Ownership check: this complaint's order must actually carry a slice of THIS seller's — a
    // seller can't flag a complaint on an order they had no part in.
    const orderIds = await ownOrderIds(req.sellerId!);
    if (!complaint.orderId || !orderIds.includes(complaint.orderId)) {
      throw new NotFoundError("Complaint", id);
    }

    const updated = await prisma.complaint.update({
      where: { id },
      data: {
        returnRequested: true,
        suggestedRefundAmount: parsed.data.suggestedRefundAmount,
        sellerNote: parsed.data.note?.trim() || null,
      },
      include: { user: { select: { name: true, phone: true } } },
    });
    res.json({ success: true, data: shapeComplaint(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
