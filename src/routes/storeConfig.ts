import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { cacheControl, memoCache } from "../lib/httpCache.js";
import { bustDeliveryPricingConfig } from "../services/deliveryPricing.js";
import { deliverySlabsInputSchema } from "../data/deliveryPricing.js";

const router = Router();

// Store config gates ordering (isOrderingAllowed) + operating hours, so it uses a SHORTER window
// than the catalog reads (20s) — a customer who already cached "open" can be at most ~20s late to
// see an owner pause. The PUT below busts the server cache immediately for everyone else.
const CONFIG_TTL_MS = 20 * 1000;
const CONFIG_TTL_SECONDS = 20;

const updateSchema = z.object({
  storeName: z.string().min(1).max(200).optional(),
  storeAddress: z.string().max(500).optional().nullable(),
  storePhone: z.string().max(15).optional().nullable(),
  storeEmail: z.string().email().optional().nullable(),
  gstin: z.string().length(15).optional().nullable(),
  pan: z.string().length(10).optional().nullable(),
  stateCode: z.string().length(2).optional(),
  legalName: z.string().max(200).optional().nullable(),
  deliveryDateLabel: z.string().max(50).optional(),
  freeDeliveryAbove: z.number().min(0).optional(),
  isOrderingAllowed: z.boolean().optional(),
  operatingHoursStart: z.string().max(10).optional().nullable(),
  operatingHoursEnd: z.string().max(10).optional().nullable(),
  deliveryRadius: z.number().min(0).optional().nullable(),
  // Store's own pickup location (owner sets once — GPS or manual pin). Both null = distance-based
  // delivery pricing stays inactive (flat deliveryCharge fallback).
  storeLat: z.number().min(-90).max(90).optional().nullable(),
  storeLng: z.number().min(-180).max(180).optional().nullable(),
  // Distance-based delivery pricing slabs (validated same as the loyalty config — hard rails even
  // through the API). Omit/null to keep the current value; send [] is invalid (min 1 slab) — send
  // null explicitly to fall back to DEFAULT_DELIVERY_SLABS.
  deliverySlabs: deliverySlabsInputSchema.optional().nullable(),
  // Referral wallet (Phase 2) — owner-tunable reward economics.
  referralEnabled: z.boolean().optional(),
  referralRewardAmount: z.number().int().min(0).max(100000).optional(),
  referralWelcomeAmount: z.number().int().min(0).max(100000).optional(),
  referralMinOrder: z.number().int().min(0).max(100000).optional(),
  referralWelcomeExpiryDays: z.number().int().min(1).max(365).optional(),
  // Seller payout automation — off by default (manual "Pay out" stays the default flow).
  autoSellerPayoutEnabled: z.boolean().optional(),
  autoSellerPayoutMinAmount: z.number().int().min(0).max(100000).optional(),
  // Delivery-partner onboarding Phase 2 (SELLER_DELIVERY_ONBOARDING_PLAN.md) — off by default
  // (optional at this scale). When on, deliveryOnboarding.ts's submit handler requires a
  // policeVerificationDocUrl before a rider can be submitted for owner review.
  requirePoliceVerificationForDelivery: z.boolean().optional(),
  // Income Tax Sec 194-O TDS on marketplace seller payouts (services/sellerTds194o.ts). Off by
  // default — a real withholding decision; confirm with the CA before enabling
  // (CA_COMPLIANCE_BRIEF.md §2.1). tds194oThreshold is the ₹5L individual/HUF no-TDS threshold.
  tds194oEnabled: z.boolean().optional(),
  tds194oRatePct: z.number().min(0).max(30).optional(),
  tds194oThreshold: z.number().min(0).max(100000000).optional(),
  tds194oNoPanRatePct: z.number().min(0).max(30).optional(),
});

// GET /api/app/config — public, no auth
router.get("/", cacheControl(CONFIG_TTL_SECONDS), async (_req, res: Response) => {
  try {
    const config = await memoCache.get("config", CONFIG_TTL_MS, async () => {
      let c = await prisma.storeConfig.findFirst();
      if (!c) c = await prisma.storeConfig.create({ data: {} });
      return c;
    });
    res.json({ success: true, data: config });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /api/app/config — owner only (Firebase auth)
router.put(
  "/",
  firebaseAuthMiddleware as any,
  requireAppRole("OWNER") as any,
  async (req: FirebaseAuthRequest, res: Response) => {
    try {
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Invalid data", details: parsed.error.errors },
        });
      }

      let config = await prisma.storeConfig.findFirst();
      // `as any`: deliverySlabs is a Json column; Prisma's generated update/create input types don't
      // accept a plain `null` literal for Json fields (they want the Prisma.JsonNull sentinel), which
      // the zod-validated array-or-null shape here doesn't match structurally. Same escape hatch this
      // codebase already uses for `loyaltyConfig` (see ownerMembership.ts).
      if (!config) {
        config = await prisma.storeConfig.create({ data: parsed.data as any });
      } else {
        config = await prisma.storeConfig.update({
          where: { id: config.id },
          data: parsed.data as any,
        });
      }

      memoCache.bust("config");
      // Bust the delivery-pricing cache too — it reads storeLat/storeLng/deliverySlabs/deliveryRadius
      // off this same row, and an owner location/slab edit should apply to the very next quote.
      bustDeliveryPricingConfig();
      res.json({ success: true, data: config });
    } catch (e) {
      sendError(res, e);
    }
  },
);

export default router;
