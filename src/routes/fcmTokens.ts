import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

const router = Router();

const tokenSchema = z.object({
  token: z.string().min(1).max(500),
  deviceInfo: z.string().max(200).optional(),
});

// All routes require Firebase auth
router.use(firebaseAuthMiddleware as any);

// POST /api/app/me/fcm-token — upsert device token
router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid data", details: parsed.error.errors },
      });
    }

    const { token, deviceInfo } = parsed.data;
    const userId = req.appUser!.id;

    await prisma.fcmToken.upsert({
      where: { token },
      update: { userId, deviceInfo, updatedAt: new Date() },
      create: { userId, token, deviceInfo },
    });

    res.json({ success: true, message: "FCM token registered" });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /api/app/me/fcm-token — remove token on logout
router.delete("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const token = req.body?.token || req.query?.token;
    if (!token || typeof token !== "string") {
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Token is required", details: [] },
      });
    }

    await prisma.fcmToken.deleteMany({
      where: { token, userId: req.appUser!.id },
    });

    res.json({ success: true, message: "FCM token removed" });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
