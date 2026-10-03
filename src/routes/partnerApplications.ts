import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { isValidGstin } from "../validators/index.js";

// "Partner with us" lead capture. Mounted at /api/app/partner-applications BEFORE the global JWT
// guard (index.ts), but the POST carries its own Firebase-token check: the applicant signs in with an
// SMS code first, so the lead is tied to a phone they proved. The shared generalLimiter still applies.
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

// A person's name: letters, spaces and . ' - only (no digits/emoji). A shop name also allows digits and & , ( ) / +.
const PERSON_NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const SHOP_NAME = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’&()\/+-]*$/u;

// Optional, but when present it must be a real GSTIN — it is copied onto the Seller row at approval
// and invoices are issued under it. Same rule (and same wording) as the KYC wizard's optionalGstin.
const leadGstin = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.replace(/\s+/g, "").toUpperCase()) : v),
  z.string().max(20).nullable().optional().refine(
    (v) => v == null || isValidGstin(v).valid,
    (v) => ({ message: v ? isValidGstin(v).error ?? "Invalid GSTIN" : "Invalid GSTIN" }),
  ),
);

// The phone is NOT a body field any more: it comes from the verified Firebase token (see the route),
// so a lead can only ever be filed for the number the caller just proved they hold.
export const applicationSchema = z.object({
  // RESTAURANT = a kitchen (restaurant, café, bakery, sweet shop): its own onboarding, its own seller vertical.
  kind: z.enum(["SELLER", "RESTAURANT", "DELIVERY"]).default("SELLER"),
  businessName: z.string().trim().min(1, "Enter your shop name").max(120, "Shop name is too long").regex(SHOP_NAME, "Shop name has characters we can't accept"),
  contactName: z.string().trim().min(1, "Enter your name").max(120, "Name is too long").regex(PERSON_NAME, "Name can only have letters and spaces"),
  email: z.preprocess(blankToNull, z.string().trim().email("Enter a valid email address").max(160).nullable().optional()),
  gstin: leadGstin,
  // Shops: comma-separated department names ("Grocery,Fresh"); restaurants: one kitchen type ("BAKERY"); riders: a free-text area. 400 fits
  // all eighteen departments with room to spare — 80 would have cut a long list mid-word.
  category: z.preprocess(blankToNull, z.string().max(400).nullable().optional()),
  message: z.string().max(2000).default(""),
});

// POST /api/app/partner-applications → submit a seller/delivery partner application.
// Needs a signed-in session: the app asks for an SMS code first, and the phone stored on the lead is the
// one that code proved (token phone), never one typed into the body. A retry after a lost response, or a
// second tap, updates the applicant's still-PENDING lead of the same kind instead of piling up duplicates.
router.post("/", firebaseAuthMiddleware as any, async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = applicationSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.errors[0]?.message ?? "Invalid application", parsed.error.errors);
    const d = parsed.data;

    const phone = req.appUser?.tokenPhone;
    if (!phone || phone.length !== 10) throw new ValidationError("Verify your phone number with the SMS code, then submit again");

    const fields = {
      businessName: d.businessName,
      contactName: d.contactName,
      email: d.email ?? null,
      gstin: d.gstin ?? null,
      category: d.category?.trim() ?? null,
      message: d.message.trim(),
    };
    // ponytail: check-then-write, so two truly simultaneous requests could still both create. The
    // client serialises its own taps; a partial unique index on (phone, kind) WHERE PENDING closes it.
    const pending = await prisma.partnerApplication.findFirst({
      where: { phone, kind: d.kind, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
    if (pending) {
      const updated = await prisma.partnerApplication.update({ where: { id: pending.id }, data: fields });
      return void res.status(200).json({ success: true, data: shapePartnerApplication(updated) });
    }

    const app = await prisma.partnerApplication.create({ data: { kind: d.kind, phone, ...fields } });
    res.status(201).json({ success: true, data: shapePartnerApplication(app) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
