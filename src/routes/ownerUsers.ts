import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// Admin user directory. Mounted at /api/app/owner/users (Firebase auth + OWNER role).
// Browse/search every app user by role; suspend/reactivate; promote/demote delivery & customers.
// Seller onboarding/approval lives in ownerSellers.ts; delivery-by-phone register in ownerStaff.ts.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

const ROLE_VALUES = [
  "OWNER", "ACCOUNTANT", "BILLING_CLERK", "VIEWER", "CUSTOMER", "DELIVERY", "SELLER",
] as const;

function shape(u: any) {
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt,
    // If this user is a seller, surface the linked Seller so the admin row can deep-link to it.
    sellerId: u.sellerAccount?.id ?? null,
    sellerSlug: u.sellerAccount?.slug ?? null,
    sellerStatus: u.sellerAccount?.status ?? null,
  };
}

const SELECT = {
  id: true, name: true, phone: true, email: true, role: true, isActive: true, createdAt: true,
  sellerAccount: { select: { id: true, slug: true, status: true } },
} as const;

// GET /api/app/owner/users?role=&q=&limit= — searchable directory (newest first).
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const role = typeof req.query.role === "string" ? req.query.role.toUpperCase() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = Math.min(Number(req.query.limit) || 100, 200);

    const where: any = {};
    if (role && (ROLE_VALUES as readonly string[]).includes(role)) where.role = role;
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
      select: SELECT,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    res.json({ success: true, data: users.map(shape) });
  } catch (e) {
    sendError(res, e);
  }
});

// PATCH /api/app/owner/users/:id — suspend/reactivate + promote/demote (customer<->delivery only).
// SELLER and OWNER roles are intentionally not settable here (sellers go through onboarding; the
// owner role is fixed) so we never strand a SELLER user without a linked Seller record.
const patchSchema = z.object({
  isActive: z.boolean().optional(),
  role: z.enum(["CUSTOMER", "DELIVERY"]).optional(),
});

router.patch("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const { isActive, role } = parsed.data;
    if (isActive === undefined && role === undefined) throw new ValidationError("Nothing to update");

    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!user) throw new NotFoundError("User", id);

    if (role !== undefined && (user.role === "SELLER" || user.role === "OWNER")) {
      throw new ValidationError("Use seller onboarding to manage a seller; the owner role can't be changed here.");
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(isActive !== undefined ? { isActive } : {}),
        ...(role !== undefined ? { role } : {}),
      },
      select: SELECT,
    });
    res.json({ success: true, data: shape(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
