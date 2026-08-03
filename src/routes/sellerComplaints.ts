import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, NotFoundError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { shapeComplaint } from "./appUser.js";
import { notifyComplaintSellerResponded } from "../services/fcmNotifier.js";

// Seller-scoped view of complaints — a seller sees NOTHING here until the owner explicitly pages
// ("forwards") a complaint to them via ownerComplaints.ts POST /:id/forward. Before this, a seller
// saw every complaint tied to any of their orders unprompted; now the owner is the sole first
// recipient and decides what, if anything, reaches the seller. Mounted at /api/app/seller/complaints.
//   GET  /                → complaints currently paged to this seller
//   POST /:id/respond      → reply to the owner's ask (visible to the owner only, never the customer)
//   POST /:id/flag-return  → recommend a refund amount for the owner to review + actually pay out
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

async function ownedForwardedComplaint(id: string, sellerId: string) {
  const complaint = await prisma.complaint.findUnique({ where: { id } });
  if (!complaint || complaint.forwardedToSellerId !== sellerId) return null;
  return complaint;
}

router.get("/", async (req: SellerRequest, res: Response) => {
  try {
    const complaints = await prisma.complaint.findMany({
      where: { forwardedToSellerId: req.sellerId },
      orderBy: { createdAt: "desc" },
      include: { user: { select: { name: true, phone: true } } },
    });
    res.json({ success: true, data: complaints.map((c) => shapeComplaint(c)) });
  } catch (e) {
    sendError(res, e);
  }
});

const respondSchema = z.object({
  text: z.string().min(1).max(2000),
});

router.post("/:id/respond", async (req: SellerRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = respondSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid response", parsed.error.errors);

    const complaint = await ownedForwardedComplaint(id, req.sellerId!);
    if (!complaint) throw new NotFoundError("Complaint", id);

    const updated = await prisma.complaint.update({
      where: { id },
      data: { sellerResponse: parsed.data.text.trim(), sellerRespondedAt: new Date() },
      include: { user: { select: { name: true, phone: true } }, forwardedSeller: { select: { name: true } } },
    });

    try {
      await notifyComplaintSellerResponded({
        complaintId: id,
        subject: complaint.subject,
        sellerName: updated.forwardedSeller?.name ?? "A seller",
      });
    } catch (notifyErr) {
      console.warn("notifyComplaintSellerResponded failed:", notifyErr);
    }

    res.json({ success: true, data: shapeComplaint(updated) });
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

    const complaint = await ownedForwardedComplaint(id, req.sellerId!);
    if (!complaint) throw new NotFoundError("Complaint", id);

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
