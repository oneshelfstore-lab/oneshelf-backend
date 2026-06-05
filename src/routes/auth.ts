import { Router, type Request, type Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma.js";
import { sendError } from "../lib/errors.js";
import {
  generateToken,
  generateRefreshToken,
  verifyToken,
  authMiddleware,
  type AuthRequest,
  type JwtPayload,
} from "../middleware/auth.js";

const router = Router();

// ─── Validation ─────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, "Password must be at least 6 characters"),
});

// ─── POST /api/auth/login ───────────────────────────────────────────

router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password", details: [] },
      });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({
        success: false,
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password", details: [] },
      });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    await prisma.auditLog.create({
      data: { userId: user.email, action: "LOGIN", entityType: "User", entityId: user.id, ipAddress: req.ip || "" },
    });

    const payload: JwtPayload = { userId: user.id, email: user.email, role: user.role, name: user.name };
    const token = generateToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.json({
      success: true,
      data: {
        token,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
        },
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/auth/refresh ─────────────────────────────────────────

router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    const payload = verifyToken(refreshToken) as JwtPayload & { type?: string };

    if (payload.type !== "refresh") {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_TOKEN", message: "Not a refresh token", details: [] },
      });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: { code: "ACCOUNT_DISABLED", message: "Account is disabled", details: [] },
      });
    }

    const newPayload: JwtPayload = { userId: user.id, email: user.email, role: user.role, name: user.name };
    const newToken = generateToken(newPayload);
    const newRefreshToken = generateRefreshToken(newPayload);

    res.json({ success: true, data: { token: newToken, refreshToken: newRefreshToken } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /api/auth/me ───────────────────────────────────────────────

router.get("/me", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, email: true, name: true, role: true, mustChangePassword: true, lastLoginAt: true, createdAt: true },
    });
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "User not found", details: [] },
      });
    }
    res.json({ success: true, data: user });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /api/auth/change-password ─────────────────────────────────

router.post("/change-password", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "User not found", details: [] },
      });
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(400).json({
        success: false,
        error: { code: "WRONG_PASSWORD", message: "Current password is incorrect", details: [] },
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });

    res.json({ success: true, data: { message: "Password changed successfully" } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
