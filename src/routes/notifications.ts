import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { actionCutoff } from "../services/notificationInbox.js";

// In-app notification inbox (any signed-in role — rows are always scoped to the caller).
// Mounted at /api/app/me/notifications. Rows are written by services/fcmNotifier.ts.
const router = Router();
router.use(firebaseAuthMiddleware as any);

const CATEGORIES = ["ORDERS", "DELIVERY", "ROUTINES", "PAYMENTS", "INVENTORY", "BUSINESS", "ACCOUNT", "SUPPORT", "PROMO", "SYSTEM"] as const;
const KINDS = ["ACTION", "STATUS", "INFO", "PROMO"] as const;

const listQuery = z.object({
  category: z.enum(CATEGORIES).optional(),
  kind: z.enum(KINDS).optional(),
  unread: z.enum(["1", "true"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // createdAt of the last row of the previous page (ISO). Newest-first, so this fetches older rows.
  before: z.string().datetime().optional(),
});

function shape(n: {
  id: string; type: string; category: string; kind: string; severity: string; title: string; body: string;
  entityType: string | null; entityId: string | null; action: string | null; imageUrl: string | null;
  etaAt: Date | null; readAt: Date | null; resolvedAt: Date | null; createdAt: Date;
}) {
  return {
    id: n.id,
    type: n.type,
    category: n.category,
    kind: n.kind,
    severity: n.severity,
    title: n.title,
    body: n.body,
    entityType: n.entityType,
    entityId: n.entityId,
    action: n.action,
    imageUrl: n.imageUrl,
    etaAt: n.etaAt?.getTime() ?? null,
    isRead: n.readAt != null,
    resolved: n.resolvedAt != null,
    createdAt: n.createdAt.getTime(),
  };
}

// ─── GET / — the feed (newest first, cursor-paged) ───
router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid query", parsed.error.errors);
    const q = parsed.data;

    const rows = await prisma.notification.findMany({
      where: {
        userId: req.appUser!.id,
        ...(q.category ? { category: q.category } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.unread ? { readAt: null } : {}),
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    res.json({
      success: true,
      data: {
        items: page.map(shape),
        nextBefore: rows.length > q.limit ? page[page.length - 1]!.createdAt.toISOString() : null,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /summary — badge + the pinned "Action required" block ───
// Declared before "/:id/..." so "summary" is never read as an id.
router.get("/summary", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const userId = req.appUser!.id;
    const pending = { userId, kind: "ACTION" as const, resolvedAt: null, createdAt: { gte: actionCutoff() } };
    const [unread, unreadByCategory, actionRows] = await Promise.all([
      prisma.notification.count({ where: { userId, readAt: null } }),
      prisma.notification.groupBy({ by: ["category"], where: { userId, readAt: null }, _count: { _all: true } }),
      prisma.notification.findMany({ where: pending, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20 }),
    ]);
    res.json({
      success: true,
      data: {
        unread,
        unreadByCategory: Object.fromEntries(unreadByCategory.map((g) => [g.category, g._count._all])),
        actionRequiredCount: actionRows.length,
        actionRequired: actionRows.map(shape),
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /read-all[?type=sub_order_new] ───
// `type` narrows it to one push type — the seller's "new orders" badge clears just those rows.
router.post("/read-all", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const type = typeof req.query.type === "string" && /^[a-z_]{1,40}$/.test(req.query.type) ? req.query.type : undefined;
    const { count } = await prisma.notification.updateMany({
      where: { userId: req.appUser!.id, readAt: null, ...(type ? { type } : {}) },
      data: { readAt: new Date() },
    });
    res.json({ success: true, data: { updated: count } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── POST /:id/read ───
// updateMany with the userId in the filter = ownership check and idempotency in one query; someone
// else's id (or a stale one) is a quiet no-op, not a 404 that leaks which ids exist.
router.post("/:id/read", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    await prisma.notification.updateMany({
      where: { id: String(req.params.id), userId: req.appUser!.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ success: true, data: { id: String(req.params.id), isRead: true } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE / — "Clear all" (this user's inbox only) ───
router.delete("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const { count } = await prisma.notification.deleteMany({ where: { userId: req.appUser!.id } });
    res.json({ success: true, data: { deleted: count } });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── DELETE /:id — swipe-to-dismiss ───
router.delete("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    await prisma.notification.deleteMany({ where: { id: String(req.params.id), userId: req.appUser!.id } });
    res.json({ success: true, data: { id: String(req.params.id), deleted: true } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
