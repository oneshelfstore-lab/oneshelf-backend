import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";

// Owner chat inbox. Mounted at /api/app/owner/inbox.
//
// One list of every conversation the store is in — order chats, bulk-order (quote) chats and
// complaint chats — newest first, each flagged `awaitingReply` when the customer spoke last.
// Nothing new is stored: it reads the three existing message tables. Replying still happens in
// each thread's own screen (same endpoints as before), this only answers "who is waiting on me".
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// ponytail: scans the last 60 days, capped per table; paginate when a store has more live
// conversations than that.
const WINDOW_DAYS = 60;
const SCAN_LIMIT = 600;

type Msg = { sender: string; text: string | null; voiceUrl: string | null; imageUrls: string[]; createdAt: Date };

function latestPer<T extends Msg>(rows: T[], key: (r: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) if (!out.has(key(r))) out.set(key(r), r); // rows arrive newest-first
  return out;
}

function preview(m: Msg): string {
  if (m.text?.trim()) return m.text.trim().slice(0, 120);
  if (m.voiceUrl) return "🎤 Voice note";
  if (m.imageUrls.length) return "📷 Photo";
  return "";
}

router.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 86400_000);
    const recent = { createdAt: { gte: since } };
    const order = { createdAt: "desc" as const };
    const [orderMsgs, quoteMsgs, complaintMsgs] = await Promise.all([
      prisma.orderMessage.findMany({ where: recent, orderBy: order, take: SCAN_LIMIT }),
      prisma.quoteMessage.findMany({ where: recent, orderBy: order, take: SCAN_LIMIT }),
      prisma.complaintMessage.findMany({ where: recent, orderBy: order, take: SCAN_LIMIT }),
    ]);
    const lastOrder = latestPer(orderMsgs, (m) => m.orderId);
    const lastQuote = latestPer(quoteMsgs, (m) => m.quoteRequestId);
    const lastComplaint = latestPer(complaintMsgs, (m) => m.complaintId);

    const who = { select: { name: true, phone: true } };
    const [orders, quotes, complaints] = await Promise.all([
      prisma.order.findMany({ where: { id: { in: [...lastOrder.keys()] } }, select: { id: true, orderNumber: true, status: true, totalAmount: true, customer: who } }),
      prisma.quoteRequest.findMany({ where: { id: { in: [...lastQuote.keys()] } }, select: { id: true, type: true, status: true, user: who } }),
      prisma.complaint.findMany({ where: { id: { in: [...lastComplaint.keys()] } }, select: { id: true, subject: true, status: true, user: who } }),
    ]);

    const threads = [
      ...orders.map((o) => ({ kind: "ORDER", id: o.id, title: `Order #${o.orderNumber.split("/").pop()}`, status: o.status, total: Number(o.totalAmount), person: o.customer, last: lastOrder.get(o.id)! })),
      ...quotes.map((q) => ({ kind: "QUOTE", id: q.id, title: `Bulk order QR-${q.id.slice(-6).toUpperCase()} · ${q.type}`, status: q.status, person: q.user, last: lastQuote.get(q.id)! })),
      ...complaints.map((c) => ({ kind: "COMPLAINT", id: c.id, title: `Complaint · ${c.subject}`, status: c.status, person: c.user, last: lastComplaint.get(c.id)! })),
    ]
      .map((t) => ({
        kind: t.kind,
        id: t.id,
        title: t.title,
        status: t.status,
        total: "total" in t ? t.total : null,
        customerName: t.person?.name ?? "",
        customerPhone: t.person?.phone ?? "",
        lastMessage: preview(t.last),
        lastSender: t.last.sender,
        lastAt: t.last.createdAt.getTime(),
        awaitingReply: t.last.sender === "CUSTOMER",
      }))
      .sort((a, b) => b.lastAt - a.lastAt);

    res.json({ success: true, data: threads });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
