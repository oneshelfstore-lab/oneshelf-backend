import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { shapePartnerApplication } from "./partnerApplications.js";

// Owner inbox for "Partner with us" applications. Mounted at
// /api/app/owner/partner-applications (Firebase-auth + OWNER, mirrors ownerQuotes).
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// GET / → all applications (newest first), optional ?status= filter.
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const status = String(req.query.status ?? "").toUpperCase();
    const where =
      status === "PENDING" || status === "APPROVED" || status === "REJECTED"
        ? { status: status as "PENDING" | "APPROVED" | "REJECTED" }
        : {};
    const apps = await prisma.partnerApplication.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: apps.map(shapePartnerApplication) });
  } catch (e) {
    sendError(res, e);
  }
});

const reviewSchema = z.object({ note: z.string().max(2000).default("") });

// Shared approve/reject — status-only for v1. Full onboarding (creating the marketplace
// Seller record or pre-registering a DELIVERY user by phone) stays in the existing admin
// flows; this just triages the lead so the owner knows who to onboard.
async function review(
  req: FirebaseAuthRequest,
  res: Response,
  status: "APPROVED" | "REJECTED",
) {
  try {
    const id = String(req.params.id ?? "");
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid review", parsed.error.errors);

    const existing = await prisma.partnerApplication.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Partner application", id);

    const updated = await prisma.partnerApplication.update({
      where: { id },
      data: { status, reviewNote: parsed.data.note.trim() || null, reviewedAt: new Date() },
    });
    res.json({ success: true, data: shapePartnerApplication(updated) });
  } catch (e) {
    sendError(res, e);
  }
}

// POST /:id/approve
router.post("/:id/approve", (req: FirebaseAuthRequest, res: Response) =>
  review(req, res, "APPROVED"),
);

// POST /:id/reject
router.post("/:id/reject", (req: FirebaseAuthRequest, res: Response) =>
  review(req, res, "REJECTED"),
);

export default router;
