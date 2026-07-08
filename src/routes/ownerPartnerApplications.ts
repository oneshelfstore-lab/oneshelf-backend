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

// Bare-10-digit normalization — mirrors ownerSellers.ts / ownerStaff.ts's own copies (this file
// doesn't share their private helpers; small per-file duplication is the established pattern here).
function normalizePhone(input: string): string {
  return input.replace(/\D/g, "").slice(-10);
}

function slugify(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return base || "seller";
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (await prisma.seller.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

// Approving a SELLER lead provisions the login (User, role=SELLER, matched/created by phone —
// same resolution ownerSellers.ts POST / uses) and a stub Seller row that starts KYC from scratch
// (status PENDING, onboardingStatus NOT_STARTED — NOT the schema's APPROVED default, which exists
// only to grandfather rows that pre-date this feature). If a Seller is already linked to this phone
// (e.g. the owner manually onboarded them before this lead was reviewed), skip provisioning —
// nothing to create, just triage the lead.
async function provisionSeller(app: { businessName: string; contactName: string; phone: string; gstin: string | null; category: string | null }) {
  const phone = normalizePhone(app.phone);
  if (phone.length !== 10) return; // shouldn't happen (already validated at submission), be defensive

  const existingUser = await prisma.user.findFirst({
    where: { phone: { in: [phone, `+91${phone}`, `91${phone}`] } },
    orderBy: { createdAt: "asc" },
    include: { sellerAccount: { select: { id: true } } },
  });
  if (existingUser?.sellerAccount) return; // already a seller — nothing to provision

  const slug = await uniqueSlug(slugify(app.businessName || app.contactName));
  await prisma.$transaction(async (tx) => {
    let userId: string;
    if (existingUser) {
      const keepName = existingUser.name && existingUser.name !== "App User" ? existingUser.name : app.contactName;
      const u = await tx.user.update({ where: { id: existingUser.id }, data: { role: "SELLER", phone, name: keepName } });
      userId = u.id;
    } else {
      const u = await tx.user.create({ data: { name: app.contactName, phone, role: "SELLER", phoneVerified: false } });
      userId = u.id;
    }
    // NOTE: PartnerApplication has no "city" field (only category/gstin) — leave city unset;
    // the seller fills their real shop address/city during onboarding.
    await tx.seller.create({
      data: {
        slug,
        name: app.businessName,
        phone,
        ownerUserId: userId,
        status: "PENDING",
        onboardingStatus: "NOT_STARTED",
        gstin: app.gstin ?? null,
      },
    });
  });
}

// Approving a DELIVERY lead provisions the login (User, role=DELIVERY, matched/created by phone —
// same resolution ownerStaff.ts POST / uses) and a stub DeliveryProfile. If a profile already
// exists for this user, skip — nothing to create.
async function provisionDeliveryRider(app: { contactName: string; phone: string }) {
  const phone = normalizePhone(app.phone);
  if (phone.length !== 10) return;

  const existing = await prisma.user.findFirst({
    where: { phone: { in: [phone, `+91${phone}`, `91${phone}`] } },
    orderBy: { createdAt: "asc" },
    include: { deliveryProfile: { select: { id: true } } },
  });

  await prisma.$transaction(async (tx) => {
    let userId: string;
    if (existing) {
      const keepName = existing.name && existing.name !== "App User" ? existing.name : app.contactName;
      const u = await tx.user.update({ where: { id: existing.id }, data: { role: "DELIVERY", phone, name: keepName } });
      userId = u.id;
      if (existing.deliveryProfile) return; // already has a profile — nothing more to do
    } else {
      const u = await tx.user.create({ data: { name: app.contactName, phone, role: "DELIVERY", phoneVerified: false } });
      userId = u.id;
    }
    await tx.deliveryProfile.create({ data: { userId, onboardingStatus: "NOT_STARTED" } });
  });
}

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

// Shared approve/reject. Approving now provisions the login + a stub Seller/DeliveryProfile row
// (Phase 1, SELLER_DELIVERY_ONBOARDING_PLAN.md) — that's the entry point into the self-service KYC
// flow the applicant sees on their next login. Rejecting is still status-only, as before.
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

    if (status === "APPROVED" && existing.status !== "APPROVED") {
      // Best-effort — a provisioning hiccup must never block the owner from at least triaging the
      // lead. If this throws, the lead still gets marked approved; the owner can create the
      // seller/agent manually via the existing ownerSellers/ownerStaff screens as a fallback.
      try {
        if (existing.kind === "DELIVERY") {
          await provisionDeliveryRider({ contactName: existing.contactName, phone: existing.phone });
        } else {
          await provisionSeller({
            businessName: existing.businessName,
            contactName: existing.contactName,
            phone: existing.phone,
            gstin: existing.gstin,
            category: existing.category,
          });
        }
      } catch (provisionErr) {
        console.error("Partner application approval — provisioning failed:", provisionErr);
      }
    }

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
