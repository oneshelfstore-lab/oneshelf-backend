import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { UserRole } from "@prisma/client";
import prisma from "../lib/prisma.js";

const JWT_SECRET = process.env.JWT_SECRET;
// Hard-fail on boot if the secret is missing, default, or weak. A predictable
// secret lets anyone forge admin JWTs and take over the billing backend, so we
// refuse to start rather than serve with an insecure key.
if (!JWT_SECRET || JWT_SECRET === "change-me-to-a-real-secret" || JWT_SECRET.length < 32) {
  throw new Error(
    "FATAL: JWT_SECRET must be set to a strong value (>= 32 chars) before starting. " +
    "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
  );
}
const SECRET = JWT_SECRET;
const TOKEN_EXPIRY = "24h";
const REFRESH_TOKEN_EXPIRY = "7d";

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  name: string;
  /** True while the account still holds its seeded / admin-reset password. Carried in the token so
   *  requirePasswordChanged can enforce it without a DB read per request. */
  mustChangePassword?: boolean;
  /** Snapshot of User.tokenVersion at issue time. authMiddleware refuses the token once the stored
   *  value moves past it. Optional so tokens issued before this shipped still validate (they read
   *  as undefined and are compared against 0, the column default). */
  tokenVersion?: number;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function generateRefreshToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, type: "refresh" }, SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, SECRET) as JwtPayload;
}

/**
 * Whether a token's baked-in version has been superseded by the stored one.
 *
 * Pure and exported so the backward-compat rule can be pinned by a test without mocking Prisma
 * (this codebase has no mocking precedent — every existing test is a pure-function test). The
 * `?? 0` is the part that matters: tokens minted before tokenVersion existed carry `undefined`,
 * and the column defaults to 0, so they must read as CURRENT. Drop the fallback and the deploy
 * signs out every dashboard user at once.
 */
export function isTokenRevoked(tokenVersion: number | undefined, storedVersion: number): boolean {
  return (tokenVersion ?? 0) !== storedVersion;
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Missing or invalid authorization header", details: [] },
    });
  }

  let payload: JwtPayload;
  try {
    const token = header.slice(7);
    payload = verifyToken(token);
    if ((payload as any).type === "refresh") {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Cannot use refresh token for API access", details: [] },
      });
    }
  } catch {
    return res.status(401).json({
      success: false,
      error: { code: "TOKEN_EXPIRED", message: "Token expired or invalid", details: [] },
    });
  }

  // Signature-valid is not the same as still-valid. A JWT is stateless and lives 24h, so without
  // this lookup a dismissed employee kept full dashboard access for up to a day after being
  // deactivated — isActive only ever gated the next LOGIN and the next REFRESH, never the token
  // already in their hands. One indexed read by primary key per dashboard request; this API is
  // low-traffic internal tooling, and the alternative is an un-revokable session.
  //
  // Deliberately NOT applied to the Firebase app auth path — that middleware has its own lookup.
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { isActive: true, tokenVersion: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: { code: "ACCOUNT_DISABLED", message: "This account is no longer active", details: [] },
      });
    }

    // Tokens minted before tokenVersion existed carry undefined; the column defaults to 0, so they
    // stay valid until something actually bumps it. That keeps the deploy from logging everyone out.
    if (isTokenRevoked(payload.tokenVersion, user.tokenVersion)) {
      return res.status(401).json({
        success: false,
        error: { code: "TOKEN_REVOKED", message: "This session has been ended. Please sign in again.", details: [] },
      });
    }
  } catch (e) {
    // A DB failure must not be mistaken for a bad token — that would read as "your login is
    // broken" during an outage. Fail closed, but say what actually happened.
    console.error("authMiddleware lookup failed:", e);
    return res.status(503).json({
      success: false,
      error: { code: "AUTH_UNAVAILABLE", message: "Could not verify your session right now", details: [] },
    });
  }

  req.user = payload;
  next();
}

/**
 * Blocks a token whose account is still on its seeded / admin-reset password.
 *
 * Before Aug 2 2026 `mustChangePassword` was returned to the client and enforced nowhere, so the
 * dashboard's nag screen was the ONLY thing standing between the seeded `admin123` and a fully
 * valid 24h token — trivially bypassed by calling the API directly with curl.
 *
 * Mounted globally on `/api` in index.ts, which is deliberately AFTER `/api/auth` is mounted:
 * `POST /api/auth/change-password` therefore never passes through here and stays reachable, so the
 * user can still fix their own password. Everything else is refused until they do.
 */
export function requirePasswordChanged(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.mustChangePassword) {
    return res.status(403).json({
      success: false,
      error: {
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "You must change your password before using the dashboard.",
        details: [],
      },
    });
  }
  next();
}

// ─── Dashboard role sets ────────────────────────────────────────────
//
// The dashboard API (`/api/*`) authenticates with authMiddleware but, before Aug 2 2026, ten of
// its routers applied NO authorization at all — so the lowest role (VIEWER) could download every
// customer's GST invoice, rewrite payroll, and forge payment records. These three sets are the
// single place that intent is now written down; gate routes with them rather than re-listing
// roles inline, so a future role change lands in one spot.
//
// Read access is deliberately broad (VIEWER means "may look"); WRITES are what these narrow.
// The one exception is payroll — employees.ts gates its reads too, since salary is not
// "look at the business", it's third-party PII.

/** Everyone allowed on the billing dashboard at all. Excludes the app roles (CUSTOMER/DELIVERY/SELLER). */
export const STAFF_ROLES: UserRole[] = ["OWNER", "ACCOUNTANT", "BILLING_CLERK", "VIEWER"];

/** May create day-to-day billing records: invoices, payments, customers. */
export const BILLING_ROLES: UserRole[] = ["OWNER", "ACCOUNTANT", "BILLING_CLERK"];

/** May touch the books: credit/debit notes, invoice cancellation, vendors, purchase bills,
 *  expenses, TDS records, payroll. Anything that restates a filed number or moves real money. */
export const FINANCE_ROLES: UserRole[] = ["OWNER", "ACCOUNTANT"];

export function requireRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Not authenticated", details: [] },
      });
    }
    if (!roles.includes(req.user.role)) {
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
