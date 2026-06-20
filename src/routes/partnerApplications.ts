import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";

// Public "Partner with us" lead capture. Mounted at /api/app/partner-applications
// BEFORE the global JWT guard (index.ts), so a not-yet-registered applicant can
// submit straight from the login page. The shared generalLimiter still rate-limits it.
const router = Router();

export function shapePartnerApplication(a: {
  id: string;
  kind: string;
  businessName: string;
  contactName: string;
  phone: string;
  email: string | null;
  gstin: string | null;
  category: string | null;
  message: string;
  status: string;
  reviewNote: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}) {
  return {
    id: a.id,
    applicationNumber: "PA-" + a.id.slice(-6).toUpperCase(),
    kind: a.kind, // SELLER | DELIVERY
    businessName: a.businessName,
    contactName: a.contactName,
    phone: a.phone,
    email: a.email,
    gstin: a.gstin,
    category: a.category,
    message: a.message,
    status: a.status, // PENDING | APPROVED | REJECTED
    reviewNote: a.reviewNote,
    createdAt: a.createdAt.getTime(),
    reviewedAt: a.reviewedAt ? a.reviewedAt.getTime() : null,
  };
}

// "" → null so optional text fields don't trip the email() check or store empties.
const blankToNull = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? null : v;

const applicationSchema = z.object({
  kind: z.enum(["SELLER", "DELIVERY"]).default("SELLER"),
  businessName: z.string().min(1).max(120),
  contactName: z.string().min(1).max(120),
  // Stored as bare 10 digits to match how the rest of the app keys users by phone.
  phone: z
    .string()
    .transform((s) => s.replace(/\D/g, "").slice(-10))
    .refine((p) => p.length === 10, "A valid 10-digit phone number is required"),
  email: z.preprocess(blankToNull, z.string().email().max(160).nullable().optional()),
  gstin: z.preprocess(blankToNull, z.string().max(20).nullable().optional()),
  category: z.preprocess(blankToNull, z.string().max(80).nullable().optional()),
  message: z.string().max(2000).default(""),
});

// POST /api/app/partner-applications → submit a seller/delivery partner application (public).
router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = applicationSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid application", parsed.error.errors);
    const d = parsed.data;

    const app = await prisma.partnerApplication.create({
      data: {
        kind: d.kind,
        businessName: d.businessName.trim(),
        contactName: d.contactName.trim(),
        phone: d.phone,
        email: d.email ?? null,
        gstin: d.gstin?.trim() ?? null,
        category: d.category?.trim() ?? null,
        message: d.message.trim(),
      },
    });

    res.status(201).json({ success: true, data: shapePartnerApplication(app) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
