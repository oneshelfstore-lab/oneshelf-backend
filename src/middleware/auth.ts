import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { UserRole } from "@prisma/client";

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

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Missing or invalid authorization header", details: [] },
    });
  }

  try {
    const token = header.slice(7);
    const payload = verifyToken(token);
    if ((payload as any).type === "refresh") {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Cannot use refresh token for API access", details: [] },
      });
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      error: { code: "TOKEN_EXPIRED", message: "Token expired or invalid", details: [] },
    });
  }
}

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
