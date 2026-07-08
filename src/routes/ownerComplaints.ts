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

// GET /api/app/owner/complaints?page=&limit= → complaints + customer name/phone (newest first),
// paginated — the inbox grows for as long as the store is in business, so an unbounded findMany
// here would re-fetch every complaint ever filed on every screen open. Same page/limit/pagination
// envelope convention as GET /api/app/orders.
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

    const [complaints, total] = await Promise.all([
      prisma.complaint.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { name: true, phone: true } } },
      }),
      prisma.complaint.count(),
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
      include: { user: { select: { name: true, phone: true } } },
    });
    res.json({ success: true, data: shapeComplaint(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
