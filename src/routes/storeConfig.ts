import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

const router = Router();

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
  // Referral wallet (Phase 2) — owner-tunable reward economics.
  referralEnabled: z.boolean().optional(),
  referralRewardAmount: z.number().int().min(0).max(100000).optional(),
  referralWelcomeAmount: z.number().int().min(0).max(100000).optional(),
  referralMinOrder: z.number().int().min(0).max(100000).optional(),
  referralWelcomeExpiryDays: z.number().int().min(1).max(365).optional(),
});

// GET /api/app/config — public, no auth
router.get("/", async (_req, res: Response) => {
  try {
    let config = await prisma.storeConfig.findFirst();
    if (!config) {
      config = await prisma.storeConfig.create({ data: {} });
    }
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
      if (!config) {
        config = await prisma.storeConfig.create({ data: parsed.data });
      } else {
        config = await prisma.storeConfig.update({
          where: { id: config.id },
          data: parsed.data,
        });
      }

      res.json({ success: true, data: config });
    } catch (e) {
      sendError(res, e);
    }
  },
);

export default router;
