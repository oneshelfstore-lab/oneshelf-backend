import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// Owner fulfillment queue for tier-up welcome hampers (Delight Phase 4). Same manual-ledger shape
// as ownerReferralPayouts.ts: the owner physically packs a gift box, ships/hands it over, then marks
// it here. No automated shipping API.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// GET /api/app/owner/hampers?status=PENDING|PACKED|SENT
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const hampers = await prisma.tierUpHamper.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      take: 200,
      include: {
        user: {
          select: {
            name: true,
            phone: true,
            addresses: { where: { isDefault: true }, take: 1 },
          },
        },
      },
    });
    res.json({
      success: true,
      data: hampers.map((h) => {
        const address = h.user.addresses[0] ?? null;
        return {
          id: h.id,
          userName: h.user.name,
          userPhone: h.user.phone,
          tierName: h.tierName,
          status: h.status,
          addressLine: address?.addressLine ?? null,
          city: address?.city ?? null,
          pincode: address?.pincode ?? null,
          createdAt: h.createdAt.getTime(),
          packedAt: h.packedAt ? h.packedAt.getTime() : null,
          sentAt: h.sentAt ? h.sentAt.getTime() : null,
        };
      }),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/owner/hampers/:id/pack — owner confirms the gift box is packed.
router.post("/:id/pack", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const hamper = await prisma.tierUpHamper.findUnique({ where: { id } });
    if (!hamper) throw new NotFoundError("TierUpHamper", id);
    if (hamper.status !== "PENDING") throw new ValidationError("Already packed");

    const updated = await prisma.tierUpHamper.update({
      where: { id },
      data: { status: "PACKED", packedAt: new Date() },
    });
    res.json({ success: true, data: { id: updated.id, status: updated.status, packedAt: updated.packedAt!.getTime() } });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/owner/hampers/:id/send — owner confirms it's shipped / handed over.
router.post("/:id/send", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const hamper = await prisma.tierUpHamper.findUnique({ where: { id } });
    if (!hamper) throw new NotFoundError("TierUpHamper", id);
    if (hamper.status === "SENT") throw new ValidationError("Already sent");
    if (hamper.status === "PENDING") throw new ValidationError("Pack it before marking it sent");

    const updated = await prisma.tierUpHamper.update({
      where: { id },
      data: { status: "SENT", sentAt: new Date() },
    });
    res.json({ success: true, data: { id: updated.id, status: updated.status, sentAt: updated.sentAt!.getTime() } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
