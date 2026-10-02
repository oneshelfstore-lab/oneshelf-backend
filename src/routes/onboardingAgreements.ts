import { Router, type Request, type Response } from "express";
import {
  PARTNER_AGREEMENT_VERSION,
  DELIVERY_AGREEMENT_VERSION,
  SENSITIVE_DATA_CONSENT_VERSION,
  LOCATION_CONSENT_VERSION,
  SELLER_PARTNER_AGREEMENT_TEXT,
  DELIVERY_PARTNER_AGREEMENT_TEXT,
  SENSITIVE_DATA_CONSENT_TEXT,
  LOCATION_TRACKING_CONSENT_TEXT,
} from "../data/onboardingAgreements.js";
import {
  SHOP_TYPES,
  DEPARTMENT_REP,
  DEPARTMENT_EXTRAS,
  EXCLUSIVE_DEPARTMENTS,
  isKnownShopType,
  effectiveProfile,
  stepsFor,
} from "../data/shopTypes.js";

// Public read of the onboarding consent copy (Phase 1). Served over the API rather than hardcoded
// in the Android app so the (currently placeholder, non-lawyer-reviewed — see
// data/onboardingAgreements.ts) text can be corrected without an app release. Mounted at
// /api/app/onboarding/agreements, before the JWT guard — plain static text, nothing sensitive.
const router = Router();

router.get("/agreements", (req: Request, res: Response) => {
  const type = String(req.query.type ?? "seller").toLowerCase();
  const isDelivery = type === "delivery";
  res.json({
    success: true,
    data: {
      agreementVersion: isDelivery ? DELIVERY_AGREEMENT_VERSION : PARTNER_AGREEMENT_VERSION,
      agreementText: isDelivery ? DELIVERY_PARTNER_AGREEMENT_TEXT : SELLER_PARTNER_AGREEMENT_TEXT,
      sensitiveDataVersion: SENSITIVE_DATA_CONSENT_VERSION,
      sensitiveDataText: SENSITIVE_DATA_CONSENT_TEXT,
      // Delivery-only in the UI (riders are the ones tracked mid-delivery), but harmless to return
      // for a seller request too — the app simply won't show this consent step for sellers.
      locationVersion: LOCATION_CONSENT_VERSION,
      locationText: LOCATION_TRACKING_CONSENT_TEXT,
    },
  });
});

// ─── Shop types + their requirement profiles (data/shopTypes.ts) ────────────────────────────────
// Public for the same reason the agreement copy is: the shop-type picker is the FIRST screen of the
// wizard, and an applicant reaches it before there is a Seller row to authenticate against. Nothing
// here is per-seller — it is the same static catalogue of trades for everyone.

/** GET /api/app/onboarding/shop-types → the picker, grouped by department. */
router.get("/shop-types", (_req: Request, res: Response) => {
  // `repKey` = the shop type this department stands for when the seller picks it as a whole (see
  // DEPARTMENT_REP). `exclusive` departments can't be combined with others. `extras` are licensed
  // lines inside the department, asked as plain yes/no.
  const departments: { department: string; repKey: string; exclusive: boolean; extras: unknown[]; shopTypes: unknown[] }[] = [];
  for (const s of SHOP_TYPES) {
    let group = departments.find((d) => d.department === s.department);
    if (!group) {
      group = {
        department: s.department,
        repKey: DEPARTMENT_REP[s.department] ?? s.key,
        exclusive: EXCLUSIVE_DEPARTMENTS.has(s.department),
        extras: DEPARTMENT_EXTRAS[s.department] ?? [],
        shopTypes: [],
      };
      departments.push(group);
    }
    group.shopTypes.push({
      key: s.key,
      label: s.label,
      vertical: s.vertical,
      catalogueModel: s.catalogueModel,
      variableWeight: Boolean(s.variableWeight),
      regulated: Boolean(s.regulated),
    });
  }
  res.json({ success: true, data: { departments } });
});

/**
 * GET /api/app/onboarding/requirements?shopType=PHARMACY → the steps and fields to render.
 *
 * Unknown/missing shopType resolves to the general-store profile rather than 404ing, so a stale app
 * build asking for a type that has since been renamed still gets a usable form instead of a dead
 * wizard. The submit gate validates against the seller's STORED type regardless of what was asked
 * for here, so a wrong guess here cannot let anyone through with the wrong paperwork.
 */
router.get("/requirements", (req: Request, res: Response) => {
  const requested = String(req.query.shopType ?? "");
  // `also` = comma-separated also-sell keys; effectiveProfile ignores unknown/kitchen ones. The
  // submit gate uses the seller's STORED list, so this only decides what the screen shows.
  const also = String(req.query.also ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const profile = effectiveProfile(isKnownShopType(requested) ? requested : null, "SHOP", also);
  res.json({
    success: true,
    data: {
      shopType: profile.key,
      label: profile.label,
      department: profile.department,
      vertical: profile.vertical,
      catalogueModel: profile.catalogueModel,
      variableWeight: Boolean(profile.variableWeight),
      regulated: Boolean(profile.regulated),
      steps: stepsFor(profile),
    },
  });
});

export default router;
