import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// Owner-managed delivery staff. Mounted at /api/app/owner/delivery-agents.
// A "delivery agent" is just a User with role = DELIVERY. The owner registers one by
// PHONE (no IDs): we promote an existing user by phone, or pre-create a DELIVERY row
// that the auth middleware links to on the agent's first phone-OTP login.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// Bare-10-digit normalization — mirrors firebaseAuthMiddleware's phone handling so
// matches succeed regardless of how the number was originally stored (+91 / 91 / raw).
function normalizePhone(input: string): string {
  return input.replace(/\D/g, "").slice(-10);
}

function shape(a: { id: string; name: string; phone: string | null; firebaseUid: string | null }) {
  return {
    id: a.id,
    name: a.name,
    phone: a.phone,
    // true once they've actually logged in (Firebase account linked); false = pre-registered,
    // waiting for their first login. They can still be assigned to orders either way.
    active: !!a.firebaseUid,
  };
}

// ─── GET /api/app/owner/delivery-agents — list delivery boys ─────────
router.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const agents = await prisma.user.findMany({
      where: { role: "DELIVERY", isActive: true },
      select: { id: true, name: true, phone: true, firebaseUid: true },
      orderBy: { name: "asc" },
    });
    res.json({ success: true, data: agents.map(shape) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/app/owner/delivery-agents — register/promote by phone ─
const registerSchema = z.object({
  phone: z.string().min(8),
  name: z.string().min(1),
});

router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid data", parsed.error.errors);
    const phone = normalizePhone(parsed.data.phone);
    const name = parsed.data.name.trim();
    if (phone.length !== 10) throw new ValidationError("Enter a valid 10-digit phone number");

    // Find an existing user by any stored phone variant.
    const existing = await prisma.user.findFirst({
      where: { phone: { in: [phone, `+91${phone}`, `91${phone}`] } },
      orderBy: { createdAt: "asc" },
    });

    let agent;
    if (existing) {
      // Promote to DELIVERY. Keep their real name if they already have one; otherwise
      // use the name the owner typed. Normalize the stored phone for clean matching.
      const keepName = existing.name && existing.name !== "App User" ? existing.name : name;
      agent = await prisma.user.update({
        where: { id: existing.id },
        data: { role: "DELIVERY", phone, name: keepName },
        select: { id: true, name: true, phone: true, firebaseUid: true },
      });
    } else {
      // Pre-register: a DELIVERY row with no Firebase account yet. firebaseAuthMiddleware
      // links the account to this row by phone on the agent's first login.
      agent = await prisma.user.create({
        data: { name, phone, role: "DELIVERY", phoneVerified: false },
        select: { id: true, name: true, phone: true, firebaseUid: true },
      });
    }

    res.json({ success: true, data: shape(agent) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE /api/app/owner/delivery-agents/:id — demote to customer ──
// Soft "remove": flips the role back to CUSTOMER (keeps the account + their order
// history intact). They simply stop appearing in the delivery-agent list / picker.
router.delete("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== "DELIVERY") {
      throw new NotFoundError("Delivery agent", id);
    }
    await prisma.user.update({ where: { id: user.id }, data: { role: "CUSTOMER" } });
    res.json({ success: true, data: { id: user.id } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
