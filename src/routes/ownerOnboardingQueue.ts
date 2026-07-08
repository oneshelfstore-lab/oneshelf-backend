import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// Owner's onboarding review queue (Phase 1, SELLER_DELIVERY_ONBOARDING_PLAN.md). Mounted at
// /api/app/owner/onboarding-queue (Firebase auth + OWNER, mirrors ownerPartnerApplications).
// Shows sellers + delivery riders currently going through self-service KYC (i.e. rows that exist
// in Seller/DeliveryProfile with a non-APPROVED onboardingStatus, or any status if a filter widens
// it) — a small, low-volume inbox at Oneshelf's scale, so no memoization/pagination is needed here
// (unlike the customer-facing catalog endpoints).
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

const ONBOARDING_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "PENDING_REVIEW", "APPROVED", "REJECTED"] as const;
type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

function isOnboardingStatus(v: string): v is OnboardingStatus {
  return (ONBOARDING_STATUSES as readonly string[]).includes(v);
}

// PENDING_REVIEW first (most actionable), then in-progress, then terminal states.
const STATUS_RANK: Record<OnboardingStatus, number> = {
  PENDING_REVIEW: 0,
  IN_PROGRESS: 1,
  NOT_STARTED: 2,
  REJECTED: 3,
  APPROVED: 4,
};

async function shapeSellerRow(s: {
  id: string; slug: string; name: string; phone: string | null; gstin: string | null; pan: string | null;
  fssaiNumber: string | null; fssaiExpiry: Date | null; fssaiDocUrl: string | null; gstinDocUrl: string | null;
  panDocUrl: string | null; bankProofUrl: string | null; grievanceOfficerName: string | null;
  grievanceOfficerPhone: string | null; grievanceOfficerEmail: string | null; shopAddress: string | null;
  city: string | null; onboardingStatus: string; onboardingRejectionReason: string | null;
  createdAt: Date; ownerUser: { name: string; phone: string | null } | null;
}) {
  const consents = await prisma.consentRecord.findMany({
    where: { subjectType: "SELLER", subjectId: s.id },
    orderBy: { grantedAt: "desc" },
    select: { consentType: true, version: true, granted: true, grantedAt: true },
  });
  return {
    type: "seller" as const,
    id: s.id,
    displayName: s.name,
    contactName: s.ownerUser?.name ?? null,
    contactPhone: s.ownerUser?.phone ?? s.phone,
    gstin: s.gstin,
    pan: s.pan,
    fssaiNumber: s.fssaiNumber,
    fssaiExpiry: s.fssaiExpiry,
    shopAddress: s.shopAddress,
    city: s.city,
    grievanceOfficerName: s.grievanceOfficerName,
    grievanceOfficerPhone: s.grievanceOfficerPhone,
    grievanceOfficerEmail: s.grievanceOfficerEmail,
    documents: {
      fssaiDocUrl: s.fssaiDocUrl,
      gstinDocUrl: s.gstinDocUrl,
      panDocUrl: s.panDocUrl,
      bankProofUrl: s.bankProofUrl,
    },
    onboardingStatus: s.onboardingStatus,
    rejectionReason: s.onboardingRejectionReason,
    createdAt: s.createdAt,
    consents,
  };
}

async function shapeDeliveryRow(p: {
  id: string; userId: string; panNumber: string | null; idDocType: string | null; idDocUrl: string | null;
  selfieUrl: string | null; vehicleType: string | null; dlNumber: string | null; dlDocUrl: string | null;
  rcNumber: string | null; rcDocUrl: string | null; insuranceExpiry: Date | null; insuranceDocUrl: string | null;
  emergencyContactName: string | null; emergencyContactPhone: string | null; policeVerificationDocUrl: string | null;
  onboardingStatus: string; rejectionReason: string | null; createdAt: Date;
  user: { name: string; phone: string | null };
}) {
  const consents = await prisma.consentRecord.findMany({
    where: { subjectType: "DELIVERY", subjectId: p.userId },
    orderBy: { grantedAt: "desc" },
    select: { consentType: true, version: true, granted: true, grantedAt: true },
  });
  return {
    type: "delivery" as const,
    id: p.id,
    displayName: p.user.name,
    contactName: p.user.name,
    contactPhone: p.user.phone,
    panNumber: p.panNumber,
    idDocType: p.idDocType,
    vehicleType: p.vehicleType,
    dlNumber: p.dlNumber,
    rcNumber: p.rcNumber,
    insuranceExpiry: p.insuranceExpiry,
    emergencyContactName: p.emergencyContactName,
    emergencyContactPhone: p.emergencyContactPhone,
    documents: {
      idDocUrl: p.idDocUrl,
      selfieUrl: p.selfieUrl,
      dlDocUrl: p.dlDocUrl,
      rcDocUrl: p.rcDocUrl,
      insuranceDocUrl: p.insuranceDocUrl,
      policeVerificationDocUrl: p.policeVerificationDocUrl,
    },
    onboardingStatus: p.onboardingStatus,
    rejectionReason: p.rejectionReason,
    createdAt: p.createdAt,
    consents,
  };
}

// ─── GET /?role=&status= — the review queue ────────────────────────
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const roleFilter = String(req.query.role ?? "").toUpperCase();
    const statusParam = String(req.query.status ?? "").toUpperCase();
    const statusFilter = isOnboardingStatus(statusParam) ? statusParam : null;

    const items: Array<Awaited<ReturnType<typeof shapeSellerRow>> | Awaited<ReturnType<typeof shapeDeliveryRow>>> = [];

    if (roleFilter !== "DELIVERY") {
      const sellers = await prisma.seller.findMany({
        where: {
          isHouse: false, // the house store never goes through partner onboarding
          ...(statusFilter ? { onboardingStatus: statusFilter } : {}),
        },
        include: { ownerUser: { select: { name: true, phone: true } } },
        orderBy: { createdAt: "desc" },
      });
      items.push(...(await Promise.all(sellers.map(shapeSellerRow))));
    }

    if (roleFilter !== "SELLER") {
      const profiles = await prisma.deliveryProfile.findMany({
        where: statusFilter ? { onboardingStatus: statusFilter } : {},
        include: { user: { select: { name: true, phone: true } } },
        orderBy: { createdAt: "desc" },
      });
      items.push(...(await Promise.all(profiles.map(shapeDeliveryRow))));
    }

    items.sort((a, b) => {
      const rankDiff = STATUS_RANK[a.onboardingStatus as OnboardingStatus] - STATUS_RANK[b.onboardingStatus as OnboardingStatus];
      if (rankDiff !== 0) return rankDiff;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    res.json({ success: true, data: items });
  } catch (e) {
    sendError(res, e);
  }
});

const rejectSchema = z.object({ reason: z.string().min(1).max(500) });

// ─── POST /:type/:id/approve ────────────────────────────────────────
router.post("/:type/:id/approve", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const type = String(req.params.type ?? "");
    const id = String(req.params.id ?? "");

    if (type === "seller") {
      const seller = await prisma.seller.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!seller) throw new NotFoundError("Seller", id);
      const updated = await prisma.seller.update({
        where: { id },
        data: {
          onboardingStatus: "APPROVED",
          onboardingRejectionReason: null,
          // This is the moment SellerStatus.PENDING stops being vestigial — a self-serve-provisioned
          // seller only actually goes live once KYC is approved.
          ...(seller.status === "PENDING" ? { status: "APPROVED" as const } : {}),
        },
      });
      return res.json({ success: true, data: { id: updated.id, onboardingStatus: updated.onboardingStatus, status: updated.status } });
    }

    if (type === "delivery") {
      const profile = await prisma.deliveryProfile.findUnique({ where: { id } });
      if (!profile) throw new NotFoundError("Delivery profile", id);
      const updated = await prisma.deliveryProfile.update({
        where: { id },
        data: { onboardingStatus: "APPROVED", rejectionReason: null },
      });
      return res.json({ success: true, data: { id: updated.id, onboardingStatus: updated.onboardingStatus } });
    }

    throw new ValidationError("type must be 'seller' or 'delivery'");
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:type/:id/reject — requires a reason, surfaced back to the applicant ────
router.post("/:type/:id/reject", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const type = String(req.params.type ?? "");
    const id = String(req.params.id ?? "");
    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("A rejection reason is required", parsed.error.errors);

    if (type === "seller") {
      const seller = await prisma.seller.findUnique({ where: { id }, select: { id: true } });
      if (!seller) throw new NotFoundError("Seller", id);
      const updated = await prisma.seller.update({
        where: { id },
        data: { onboardingStatus: "REJECTED", onboardingRejectionReason: parsed.data.reason.trim() },
      });
      return res.json({ success: true, data: { id: updated.id, onboardingStatus: updated.onboardingStatus } });
    }

    if (type === "delivery") {
      const profile = await prisma.deliveryProfile.findUnique({ where: { id } });
      if (!profile) throw new NotFoundError("Delivery profile", id);
      const updated = await prisma.deliveryProfile.update({
        where: { id },
        data: { onboardingStatus: "REJECTED", rejectionReason: parsed.data.reason.trim() },
      });
      return res.json({ success: true, data: { id: updated.id, onboardingStatus: updated.onboardingStatus } });
    }

    throw new ValidationError("type must be 'seller' or 'delivery'");
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
