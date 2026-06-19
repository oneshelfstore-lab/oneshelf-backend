import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, NotFoundError } from "../lib/errors.js";
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

// GET /api/app/owner/complaints → all complaints + customer name/phone (newest first)
router.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const complaints = await prisma.complaint.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: { select: { name: true, phone: true } } },
    });
    res.json({ success: true, data: complaints.map((c) => shapeComplaint(c)) });
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
      include: { user: { select: { name: true, phone: true } } },
    });
    res.json({ success: true, data: shapeComplaint(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
