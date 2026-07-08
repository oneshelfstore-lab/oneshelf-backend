import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { DELIVERY_AGREEMENT_VERSION } from "../data/onboardingAgreements.js";

// Delivery-rider self-service KYC (Phase 1, SELLER_DELIVERY_ONBOARDING_PLAN.md). Mounted at
// /api/app/delivery/onboarding (Firebase auth + DELIVERY role). Distinct from delivery.ts's
// GET/PATCH /orders/me (the OPERATIONAL profile — availability toggle, today's stats); this is the
// one-time KYC draft. Keyed 1:1 by userId — no separate "resolve" middleware needed (unlike sellers,
// which resolve indirectly via Seller.ownerUserId), since DeliveryProfile.userId IS req.appUser.id.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("DELIVERY") as any);

// A DELIVERY user who existed before this feature (registered by phone via ownerStaff.ts) has NO
// row here. ⚠️ Deliberately asymmetric: GET is READ-ONLY (never creates a row) so it's safe to call
// from the nav-gate on EVERY delivery login without accidentally onboarding-gating a pre-existing
// rider just by looking; a missing row reads as a virtual, already-APPROVED (grandfathered) draft.
// PUT / and the consent endpoints DO create the row on first real write — that's the moment a
// rider actually starts the new flow. (A genuinely new rider, provisioned via
// ownerPartnerApplications.ts's approval, already has a real NOT_STARTED row from the start, so
// this distinction only matters for a legacy pre-existing rider who happens to open this screen.)
type DeliveryProfileRow = NonNullable<Awaited<ReturnType<typeof prisma.deliveryProfile.findUnique>>>;

function virtualDefaultProfile(userId: string): DeliveryProfileRow {
  const now = new Date();
  return {
    id: "", userId, panNumber: null, idDocType: null, idDocUrl: null, selfieUrl: null,
    vehicleType: null, dlNumber: null, dlDocUrl: null, rcNumber: null, rcDocUrl: null,
    insuranceExpiry: null, insuranceDocUrl: null, bankDetails: null, emergencyContactName: null,
    emergencyContactPhone: null, policeVerificationDocUrl: null,
    onboardingStatus: "APPROVED", agreementVersion: null, rejectionReason: null,
    createdAt: now, updatedAt: now,
  } as DeliveryProfileRow;
}

async function getOrCreateProfile(userId: string): Promise<DeliveryProfileRow> {
  const existing = await prisma.deliveryProfile.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.deliveryProfile.create({ data: { userId } });
}

function shapeProfile(p: DeliveryProfileRow, agreementCurrent: boolean) {
  return {
    id: p.id,
    panNumber: p.panNumber,
    idDocType: p.idDocType,
    idDocUrl: p.idDocUrl,
    selfieUrl: p.selfieUrl,
    vehicleType: p.vehicleType,
    dlNumber: p.dlNumber,
    dlDocUrl: p.dlDocUrl,
    rcNumber: p.rcNumber,
    rcDocUrl: p.rcDocUrl,
    insuranceExpiry: p.insuranceExpiry,
    insuranceDocUrl: p.insuranceDocUrl,
    bankDetails: p.bankDetails ?? null,
    emergencyContactName: p.emergencyContactName,
    emergencyContactPhone: p.emergencyContactPhone,
    policeVerificationDocUrl: p.policeVerificationDocUrl,
    onboardingStatus: p.onboardingStatus,
    rejectionReason: p.rejectionReason,
    // ─── Consent-version re-prompt (Phase 2) — see the identical note in sellerAccount.ts ──
    agreementCurrent,
  };
}

// True once this rider's latest granted PARTNER_AGREEMENT consent matches the CURRENT version.
async function isAgreementCurrent(userId: string): Promise<boolean> {
  const latest = await prisma.consentRecord.findFirst({
    where: { subjectType: "DELIVERY", subjectId: userId, consentType: "PARTNER_AGREEMENT", granted: true },
    orderBy: { grantedAt: "desc" },
  });
  return latest == null || latest.version === DELIVERY_AGREEMENT_VERSION;
}

// ─── GET / — this rider's KYC draft (read-only; see the note above) ──
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    if (!req.appUser) throw new NotFoundError("User", "");
    const existing = await prisma.deliveryProfile.findUnique({ where: { userId: req.appUser.id } });
    const agreementCurrent = existing ? await isAgreementCurrent(req.appUser.id) : true;
    res.json({ success: true, data: shapeProfile(existing ?? virtualDefaultProfile(req.appUser.id), agreementCurrent) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PUT / — progressive save. Document fields are Firebase Storage URLs, uploaded client-side ──
const updateSchema = z.object({
  panNumber: z.string().max(10).optional().nullable(),
  idDocType: z.enum(["AADHAAR", "VOTER_ID", "DL"]).optional().nullable(),
  idDocUrl: z.string().max(500).optional().nullable(),
  selfieUrl: z.string().max(500).optional().nullable(),
  vehicleType: z.enum(["CYCLE", "SCOOTER", "BIKE"]).optional().nullable(),
  dlNumber: z.string().max(20).optional().nullable(),
  dlDocUrl: z.string().max(500).optional().nullable(),
  rcNumber: z.string().max(20).optional().nullable(),
  rcDocUrl: z.string().max(500).optional().nullable(),
  insuranceExpiry: z.coerce.date().optional().nullable(),
  insuranceDocUrl: z.string().max(500).optional().nullable(),
  bankDetails: z.any().optional().nullable(),
  emergencyContactName: z.string().max(120).optional().nullable(),
  emergencyContactPhone: z.string().max(15).optional().nullable(),
  policeVerificationDocUrl: z.string().max(500).optional().nullable(),
});

router.put("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    if (!req.appUser) throw new NotFoundError("User", "");
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid onboarding data", parsed.error.errors);

    const existing = await getOrCreateProfile(req.appUser.id);
    const updated = await prisma.deliveryProfile.update({
      where: { userId: req.appUser.id },
      data: {
        ...parsed.data,
        // Editing after submission means the owner would review stale data — un-submit.
        ...(existing.onboardingStatus === "PENDING_REVIEW" ? { onboardingStatus: "IN_PROGRESS" as const } : {}),
      },
    });
    res.json({ success: true, data: shapeProfile(updated, await isAgreementCurrent(req.appUser.id)) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /submit — submit for owner review ────────────────────────
router.post("/submit", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    if (!req.appUser) throw new NotFoundError("User", "");
    const profile = await getOrCreateProfile(req.appUser.id);
    if (profile.onboardingStatus === "APPROVED") {
      return res.json({ success: true, data: shapeProfile(profile, await isAgreementCurrent(req.appUser.id)) });
    }

    const missing: string[] = [];
    if (!profile.idDocType) missing.push("ID document type");
    if (!profile.idDocUrl) missing.push("ID document photo");
    if (!profile.selfieUrl) missing.push("Selfie photo");
    if (!profile.vehicleType) missing.push("Vehicle type");
    if (!profile.emergencyContactPhone) missing.push("Emergency contact phone");
    // A cycle rider has no licence/registration to show; a scooter/bike rider does.
    if (profile.vehicleType && profile.vehicleType !== "CYCLE") {
      if (!profile.dlNumber || !profile.dlDocUrl) missing.push("Driving licence");
      if (!profile.rcNumber || !profile.rcDocUrl) missing.push("Vehicle registration (RC)");
    }
    // Owner-toggleable (Phase 2) — off by default, so most stores never hit this branch.
    const config = await prisma.storeConfig.findFirst({ select: { requirePoliceVerificationForDelivery: true } });
    if (config?.requirePoliceVerificationForDelivery && !profile.policeVerificationDocUrl) {
      missing.push("Police verification document");
    }
    if (missing.length > 0) {
      throw new ValidationError(`Please complete: ${missing.join(", ")}`, missing);
    }

    const [hasAgreement, hasSensitive, hasLocation] = await Promise.all([
      prisma.consentRecord.findFirst({
        where: { subjectType: "DELIVERY", subjectId: req.appUser.id, consentType: "PARTNER_AGREEMENT", version: DELIVERY_AGREEMENT_VERSION, granted: true },
      }),
      prisma.consentRecord.findFirst({
        where: { subjectType: "DELIVERY", subjectId: req.appUser.id, consentType: "SENSITIVE_DATA_PROCESSING", granted: true },
      }),
      prisma.consentRecord.findFirst({
        where: { subjectType: "DELIVERY", subjectId: req.appUser.id, consentType: "LOCATION_TRACKING", granted: true },
      }),
    ]);
    if (!hasAgreement || !hasSensitive || !hasLocation) {
      throw new ValidationError("Please accept the partner agreement and required consents before submitting.");
    }

    const updated = await prisma.deliveryProfile.update({
      where: { userId: req.appUser.id },
      data: { onboardingStatus: "PENDING_REVIEW", rejectionReason: null },
    });
    res.json({ success: true, data: shapeProfile(updated, true) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Consent (per-purpose, versioned — DPDP; never one blanket checkbox) ───────────
const consentSchema = z.object({
  consentType: z.enum(["PARTNER_AGREEMENT", "SENSITIVE_DATA_PROCESSING", "LOCATION_TRACKING", "POLICE_VERIFICATION"]),
  version: z.string().min(1).max(60),
  granted: z.boolean().default(true),
});

router.post("/consent", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    if (!req.appUser) throw new NotFoundError("User", "");
    const parsed = consentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid consent data", parsed.error.errors);

    // Make sure a profile row exists so the owner queue can find this rider once they submit.
    await getOrCreateProfile(req.appUser.id);

    const record = await prisma.consentRecord.create({
      data: {
        subjectType: "DELIVERY",
        subjectId: req.appUser.id,
        consentType: parsed.data.consentType,
        version: parsed.data.version,
        granted: parsed.data.granted,
      },
    });
    await prisma.deliveryProfile.updateMany({
      where: { userId: req.appUser.id, onboardingStatus: "NOT_STARTED" },
      data: { onboardingStatus: "IN_PROGRESS" },
    });
    res.status(201).json({ success: true, data: { id: record.id, consentType: record.consentType, grantedAt: record.grantedAt } });
  } catch (e) {
    sendError(res, e);
  }
});

router.get("/consent", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    if (!req.appUser) throw new NotFoundError("User", "");
    const records = await prisma.consentRecord.findMany({
      where: { subjectType: "DELIVERY", subjectId: req.appUser.id },
      orderBy: { grantedAt: "desc" },
    });
    res.json({
      success: true,
      data: records.map((r) => ({ id: r.id, consentType: r.consentType, version: r.version, granted: r.granted, grantedAt: r.grantedAt })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
