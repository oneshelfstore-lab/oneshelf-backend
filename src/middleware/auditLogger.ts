import type { Response, NextFunction } from "express";
import type { AuthRequest } from "./auth.js";
import prisma from "../lib/prisma.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function actionFromMethod(method: string): "CREATE" | "UPDATE" | "DELETE" {
  if (method === "POST") return "CREATE";
  if (method === "DELETE") return "DELETE";
  return "UPDATE";
}

function extractEntityInfo(path: string): { entityType: string; entityId: string | null } {
  // /api/invoices/abc123/cancel → entityType="Invoice", entityId="abc123"
  // /api/products → entityType="Product", entityId=null
  const parts = path.replace(/^\/api\//, "").split("/").filter(Boolean);
  const raw = parts[0] || "unknown";
  const entityType = raw
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/s$/, "")
    .replace(/^./, (c) => c.toUpperCase());
  const entityId = parts.length > 1 && !["search", "bulk", "credit-note", "cancel", "payment", "new"].includes(parts[1])
    ? parts[1]
    : null;
  return { entityType, entityId };
}

export function auditLoggerMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (!MUTATING_METHODS.has(req.method)) return next();

  const originalJson = res.json.bind(res);

  res.json = function (body: any) {
    const statusCode = res.statusCode;
    // Some routes (invoices, payments) log their own richer entry — e.g. distinguishing
    // Invoice/CreditNote/DebitNote or a CANCEL action that this URL-derived logger can't infer.
    // They set res.locals.auditLogged before responding so we don't double-write.
    if (statusCode >= 200 && statusCode < 300 && !res.locals.auditLogged) {
      const { entityType, entityId } = extractEntityInfo(req.originalUrl);
      const resolvedId = entityId || body?.data?.id || body?.id || "unknown";
      const action = actionFromMethod(req.method);
      const userId = req.user?.email || "anonymous";
      const ip = req.ip || req.socket.remoteAddress || "";

      prisma.auditLog.create({
        data: {
          userId,
          action,
          entityType,
          entityId: resolvedId,
          newValues: req.method !== "DELETE" ? sanitizeBody(req.body) : undefined,
          ipAddress: ip,
        },
      }).catch((err) => {
        console.error(`AUDIT LOG FAILURE [${action} ${entityType}/${resolvedId} by ${userId}]:`, err.message);
      });
    }

    return originalJson(body);
  };

  next();
}

function sanitizeBody(body: unknown): object | undefined {
  if (!body || typeof body !== "object") return undefined;
  const sanitized = { ...(body as Record<string, unknown>) };
  const sensitive = ["password", "passwordHash", "token", "refreshToken", "secret"];
  for (const key of sensitive) {
    if (key in sanitized) sanitized[key] = "[REDACTED]";
  }
  return sanitized;
}
