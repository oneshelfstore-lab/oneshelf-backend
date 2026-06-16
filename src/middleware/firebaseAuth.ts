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
      const email = decoded.email ?? null;
      // Bare-10-digit phone (matches how we store it: strip +91 / spaces / dashes).
      const phone10 = decoded.phone_number
        ? decoded.phone_number.replace(/\D/g, "").slice(-10)
        : null;

      // 1) Link by PHONE — this is what lets the owner PRE-REGISTER a delivery agent
      //    (or any role) by phone number before that person has ever logged in. On
      //    their first phone-OTP login we attach this Firebase account to the row the
      //    owner created, keeping the pre-assigned role (e.g. DELIVERY). Only ever link
      //    an UNCLAIMED row (firebaseUid: null) so we can't hijack an existing account.
      const byPhone = phone10
        ? await prisma.user.findFirst({
            where: {
              firebaseUid: null,
              phone: { in: [phone10, `+91${phone10}`, `91${phone10}`] },
            },
          })
        : null;

      if (byPhone) {
        user = await prisma.user.update({
          where: { id: byPhone.id },
          // Normalize the stored phone + mark verified (a phone token proves the number).
          data: { firebaseUid: decoded.uid, phone: phone10, phoneVerified: true },
        });
      } else {
        // 2) Link by e-mail (Google). User.email is @unique, so a row may already hold
        //    this e-mail (a seeded dashboard user, or a phone-auth account that saved the
        //    same e-mail). A blind create would throw P2002 and surface as a bogus 401.
        const byEmail = email
          ? await prisma.user.findUnique({ where: { email } })
          : null;

        if (byEmail && !byEmail.firebaseUid && decoded.email_verified) {
          // The Google token proves ownership of the e-mail — link the Firebase
          // account to the existing row (keeps role, orders, addresses).
          user = await prisma.user.update({
            where: { id: byEmail.id },
            data: { firebaseUid: decoded.uid },
          });
        } else {
          // 3) No match — create a fresh customer row.
          user = await prisma.user.create({
            data: {
              firebaseUid: decoded.uid,
              // If the e-mail is taken by a row we can't link to, create without it.
              email: byEmail ? null : email,
              name: decoded.name ?? decoded.phone_number ?? "App User",
              phone: phone10,
              role: "CUSTOMER",
              phoneVerified: !!decoded.phone_number,
            },
          });
        }
      }
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
  } catch (e) {
    // Not only bad tokens land here — DB failures during the auto-create do too.
    console.error("firebaseAuthMiddleware error:", e);
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
