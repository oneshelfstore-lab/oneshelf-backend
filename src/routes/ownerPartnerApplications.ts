import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { shapePartnerApplication } from "./partnerApplications.js";
import { notifyPartnerApproved, notifyPartnerRejected } from "../services/fcmNotifier.js";
import { sellerSetupFromLead } from "../data/shopTypes.js";

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
// Returns the provisioned user's id so the caller can notify them, or null when nothing was
// provisioned (bad phone / already a seller) — in which case there is nothing to announce.
// The applicant's email, only if no other account already owns it. User.email is UNIQUE and also the
// dashboard-login identifier, so a clash must be skipped silently — losing a contact email is better
// than failing the whole approval, and the applicant can still add it later.
async function emailIfFree(db: Pick<typeof prisma, "user">, email: string | null | undefined, selfId?: string): Promise<string | null> {
  const e = email?.trim().toLowerCase();
  if (!e) return null;
  const clash = await db.user.findUnique({ where: { email: e }, select: { id: true } });
  return clash && clash.id !== selfId ? null : e;
}

export async function provisionSeller(app: { kind: string; businessName: string; contactName: string; phone: string; email: string | null; gstin: string | null; category: string | null }): Promise<string | null> {
  const phone = normalizePhone(app.phone);
  if (phone.length !== 10) return null; // shouldn't happen (already validated at submission), be defensive

  const existingUser = await prisma.user.findFirst({
    where: { phone: { in: [phone, `+91${phone}`, `91${phone}`] } },
    orderBy: { createdAt: "asc" },
    include: { sellerAccount: { select: { id: true, onboardingStatus: true } } },
  });
  if (existingUser?.sellerAccount) {
    // ⚠️ A REJECTED seller who applies again is the normal retry path (the rejection screen reads
    // like "apply again", so people do). Returning null here left the row REJECTED with the old
    // reason, so the owner approved the new lead and the applicant still saw "Changes needed" on
    // login. Re-open it instead: keep everything they already filled in, drop the stale reason.
    if (existingUser.sellerAccount.onboardingStatus === "REJECTED") {
      await prisma.seller.update({
        where: { id: existingUser.sellerAccount.id },
        data: { onboardingStatus: "IN_PROGRESS", onboardingRejectionReason: null },
      });
      return existingUser.id;
    }
    return null; // already a seller (in progress or approved) — nothing to provision
  }

  // What they ticked on the lead form becomes the wizard's starting selection (null = free text).
  const setup = sellerSetupFromLead(app.kind, app.category);
  const slug = await uniqueSlug(slugify(app.businessName || app.contactName));
  return prisma.$transaction(async (tx) => {
    let userId: string;
    if (existingUser) {
      const keepName = existingUser.name && existingUser.name !== "App User" ? existingUser.name : app.contactName;
      const email = existingUser.email ? undefined : (await emailIfFree(tx, app.email, existingUser.id)) ?? undefined;
      const u = await tx.user.update({ where: { id: existingUser.id }, data: { role: "SELLER", phone, name: keepName, ...(email ? { email } : {}) } });
      userId = u.id;
    } else {
      const email = await emailIfFree(tx, app.email);
      const u = await tx.user.create({ data: { name: app.contactName, phone, role: "SELLER", phoneVerified: false, ...(email ? { email } : {}) } });
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
        ...(setup ? { shopType: setup.shopType, alsoSellCategories: setup.alsoSell, vertical: setup.vertical } : {}),
      },
    });
    return userId;
  });
}

// Approving a DELIVERY lead provisions the login (User, role=DELIVERY, matched/created by phone —
// same resolution ownerStaff.ts POST / uses) and a stub DeliveryProfile. If a profile already
// exists for this user, skip — nothing to create.
// Returns the provisioned user's id (see provisionSeller), or null when nothing was provisioned.
async function provisionDeliveryRider(app: { contactName: string; phone: string; email: string | null }): Promise<string | null> {
  const phone = normalizePhone(app.phone);
  if (phone.length !== 10) return null;

  const existing = await prisma.user.findFirst({
    where: { phone: { in: [phone, `+91${phone}`, `91${phone}`] } },
    orderBy: { createdAt: "asc" },
    include: { deliveryProfile: { select: { id: true, onboardingStatus: true } } },
  });

  return prisma.$transaction(async (tx) => {
    let userId: string;
    if (existing) {
      const keepName = existing.name && existing.name !== "App User" ? existing.name : app.contactName;
      const email = existing.email ? undefined : (await emailIfFree(tx, app.email, existing.id)) ?? undefined;
      const u = await tx.user.update({ where: { id: existing.id }, data: { role: "DELIVERY", phone, name: keepName, ...(email ? { email } : {}) } });
      userId = u.id;
      if (existing.deliveryProfile) {
        // Same retry trap as provisionSeller: a rejected rider who re-applies must be re-opened, or
        // they keep seeing the old rejection after the owner approves them again.
        if (existing.deliveryProfile.onboardingStatus === "REJECTED") {
          await tx.deliveryProfile.update({
            where: { id: existing.deliveryProfile.id },
            data: { onboardingStatus: "IN_PROGRESS", rejectionReason: null },
          });
          return userId;
        }
        return null; // already has a live profile — nothing more to do
      }
    } else {
      const email = await emailIfFree(tx, app.email);
      const u = await tx.user.create({ data: { name: app.contactName, phone, role: "DELIVERY", phoneVerified: false, ...(email ? { email } : {}) } });
      userId = u.id;
    }
    await tx.deliveryProfile.create({ data: { userId, onboardingStatus: "NOT_STARTED" } });
    return userId;
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

    // An approved lead already has a login + Seller/DeliveryProfile behind it; flipping the lead to
    // REJECTED would leave the two disagreeing. Acting on the account is the seller queue's job.
    if (status === "REJECTED" && existing.status === "APPROVED") {
      throw new ConflictError("This application is already approved. Reject or suspend the seller from the KYC list instead.");
    }

    // RESTAURANT is a seller as far as accounts, pushes and wording go; only provisioning cares which.
    const kind = existing.kind === "DELIVERY" ? "DELIVERY" : "SELLER";
    if (status === "APPROVED" && existing.status !== "APPROVED") {
      // ⚠️ NOT best-effort any more. This used to swallow a provisioning failure and still mark the
      // lead APPROVED, so the applicant saw "You're approved" with no Seller row behind it. Now a
      // failure returns an error and the lead stays PENDING, so the owner can simply tap Approve again
      // (provisioning is idempotent: an already-provisioned phone returns null, nothing duplicated).
      const provisionedUserId = kind === "DELIVERY"
        ? await provisionDeliveryRider({ contactName: existing.contactName, phone: existing.phone, email: existing.email })
        : await provisionSeller({
          kind: existing.kind,
          businessName: existing.businessName,
          contactName: existing.contactName,
          phone: existing.phone,
          email: existing.email,
          gstin: existing.gstin,
          category: existing.category,
        });
      // Fire-and-forget: a push must never fail the approval (same convention as every other
      // notify* call here). Reaches them only if they already have the app — see the notifier.
      if (provisionedUserId) {
        notifyPartnerApproved(provisionedUserId, kind, "PROVISIONED")
          .catch((e: unknown) => console.error("[background task failed]", e));
      }
    }

    if (status === "REJECTED" && existing.status !== "REJECTED") {
      // The applicant signed in with this phone to file the lead, so an account normally exists. Tell
      // them why — the status screen promises a notification on any update.
      const phone = normalizePhone(existing.phone);
      const applicant = phone.length === 10
        ? await prisma.user.findFirst({ where: { phone: { in: [phone, `+91${phone}`, `91${phone}`] } }, select: { id: true } })
        : null;
      if (applicant) {
        notifyPartnerRejected(applicant.id, kind, "LEAD", parsed.data.note)
          .catch((e: unknown) => console.error("[background task failed]", e));
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
