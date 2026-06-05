import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@prisma/client";
import { admin, isFirebaseInitialized } from "../lib/firebase.js";
import prisma from "../lib/prisma.js";

export interface FirebaseAuthUser {
  id: string;
  firebaseUid: string;
  email: string | null;
  name: string;
  role: UserRole;
  phone: string | null;
}

export interface FirebaseAuthRequest extends Request {
  appUser?: FirebaseAuthUser;
}

export async function firebaseAuthMiddleware(
  req: FirebaseAuthRequest,
  res: Response,
  next: NextFunction,
) {
  if (!isFirebaseInitialized()) {
    return res.status(503).json({
      success: false,
      error: {
        code: "FIREBASE_NOT_CONFIGURED",
        message: "Firebase is not configured on the server",
        details: [],
      },
    });
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid authorization header",
        details: [],
      },
    });
  }

  try {
    const idToken = header.slice(7);
    const decoded = await admin.auth().verifyIdToken(idToken);

    let user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          firebaseUid: decoded.uid,
          email: decoded.email ?? null,
          name: decoded.name ?? decoded.phone_number ?? "App User",
          phone: decoded.phone_number?.replace("+91", "") ?? null,
          role: "CUSTOMER",
          phoneVerified: !!decoded.phone_number,
        },
      });
    }

    req.appUser = {
      id: user.id,
      firebaseUid: user.firebaseUid!,
      email: user.email,
      name: user.name,
      role: user.role,
      phone: user.phone,
    };

    next();
  } catch {
    return res.status(401).json({
      success: false,
      error: {
        code: "TOKEN_INVALID",
        message: "Firebase ID token is invalid or expired",
        details: [],
      },
    });
  }
}

export function requireAppRole(...roles: UserRole[]) {
  return (req: FirebaseAuthRequest, res: Response, next: NextFunction) => {
    if (!req.appUser) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Not authenticated", details: [] },
      });
    }
    if (!roles.includes(req.appUser.role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `This action requires one of these roles: ${roles.join(", ")}`,
          details: [],
        },
      });
    }
    next();
  };
}
