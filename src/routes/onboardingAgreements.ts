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

export default router;
