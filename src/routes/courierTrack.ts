import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { createHash } from "crypto";
import prisma from "../lib/prisma.js";

/**
 * The recipient's tracking page: GET /t/:token — a tiny server-rendered HTML page, no app and no login
 * (COURIER_PLAN.md P4). The recipient of a courier has no OneShelf account, and this is how they see
 * the parcel coming and get the delivery code to hand the rider.
 *
 * ⚠️ Deliberately SMALL in what it reveals. The token is the only credential (18 random bytes, created
 * only when the sender taps Share), so the page shows NO addresses, NO phone numbers and NO rider
 * position — just status, the rider's first name and, only while the parcel is out for delivery, the
 * delivery code the recipient must read out. Anyone who holds the link could read that code, which is
 * the point of a link the sender chose to send; it is the same secret the sender would otherwise have
 * typed into a message.
 *
 * ⚠️ Every value interpolated into the HTML goes through esc(). The only user-controlled strings are
 * the recipient's and rider's names.
 */
const router = Router();

router.use(
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests",
  }),
);

/** A finished booking's link stops working after this long. */
const LINK_TTL_AFTER_END_MS = 7 * 24 * 60 * 60 * 1000;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

const firstName = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0] ?? "";

const STEPS: { label: string; reached: (s: string) => boolean }[] = [
  { label: "Booking confirmed", reached: (s) => s !== "PENDING_PAYMENT" },
  { label: "Delivery partner assigned", reached: (s) => ["ASSIGNED", "PICKED_UP", "DELIVERED"].includes(s) },
  { label: "Parcel picked up", reached: (s) => ["PICKED_UP", "DELIVERED"].includes(s) },
  { label: "Delivered", reached: (s) => s === "DELIVERED" },
];

const HEADLINE: Record<string, string> = {
  PENDING_PAYMENT: "Booking being confirmed",
  SEARCHING: "Finding a delivery partner",
  ASSIGNED: "A delivery partner is collecting your parcel",
  PICKED_UP: "Your parcel is on its way",
  DELIVERED: "Delivered",
  CANCELLED: "This delivery was cancelled",
  FAILED: "Delivery could not be completed",
};

const CSS = `body{margin:0;background:#f5f4ef;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2328}
main{max-width:440px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#64748b;font-size:14px;margin:0 0 20px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:16px;margin-bottom:14px}
.step{display:flex;align-items:center;gap:12px;padding:8px 0;color:#94a3b8;font-size:15px}
.step.on{color:#1f2328;font-weight:600}.dot{width:20px;height:20px;border-radius:50%;background:#e2e8f0;flex:none}
.on .dot{background:#1f2328}
.code{display:flex;gap:8px;justify-content:center;margin:12px 0}
.code span{width:40px;height:52px;border:1px solid #e2e8f0;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;background:#f8fafc}
.note{color:#64748b;font-size:13px;text-align:center}
.brand{font-weight:800;margin-bottom:16px}
`;

/**
 * ⚠️ The server's global CSP is deny-all (styleSrc 'none'), which would leave this page unstyled. This
 * route gets its OWN policy that allows exactly one thing: a style element whose SHA-256 matches the
 * CSS above. Edit the CSS and the hash follows automatically; no 'unsafe-inline', no scripts, no network.
 */
const CSS_HASH = createHash("sha256").update(CSS).digest("base64");
const CSP = `default-src 'none'; style-src 'sha256-${CSS_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function page(body: string, refresh: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
${refresh ? '<meta http-equiv="refresh" content="20">' : ""}
<title>OneShelf Courier</title>
<style>${CSS}</style></head><body><main><div class="brand">OneShelf Courier</div>${body}</main></body></html>`;
}

router.get("/:token", async (req: Request, res: Response) => {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Content-Security-Policy": CSP });
  const token = String(req.params.token ?? "");
  // Shape-check before touching the DB: anything that can't be one of our tokens is a 404 without a query.
  const b = /^[A-Za-z0-9_-]{20,40}$/.test(token)
    ? await prisma.courierBooking.findUnique({
        where: { trackingToken: token },
        select: {
          number: true, status: true, recipientName: true, deliveredAt: true, cancelledAt: true, updatedAt: true,
          rider: { select: { name: true } }, secret: { select: { deliveryOtp: true } },
        },
      })
    : null;

  const endedAt = b ? (b.deliveredAt ?? b.cancelledAt ?? (b.status === "FAILED" ? b.updatedAt : null)) : null;
  if (!b || (endedAt && Date.now() - endedAt.getTime() > LINK_TTL_AFTER_END_MS)) {
    return res.status(404).send(page(`<div class="card"><h1>Link not found</h1><p class="sub">This tracking link is invalid or has expired.</p></div>`, false));
  }

  const live = ["PENDING_PAYMENT", "SEARCHING", "ASSIGNED", "PICKED_UP"].includes(b.status);
  const rider = firstName(b.rider?.name);
  const steps = STEPS.map((s) => `<div class="step ${s.reached(b.status) ? "on" : ""}"><span class="dot"></span>${esc(s.label)}</div>`).join("");

  // The delivery code appears ONLY while the parcel is out for delivery — the one moment the recipient needs it.
  const code =
    b.status === "PICKED_UP" && b.secret
      ? `<div class="card"><strong>Your delivery code</strong><div class="code">${[...b.secret.deliveryOtp].map((d) => `<span>${esc(d)}</span>`).join("")}</div>
<p class="note">Give this code to the delivery partner only when your parcel arrives.</p></div>`
      : "";

  const body = `<h1>${esc(HEADLINE[b.status] ?? b.status)}</h1>
<p class="sub">${esc(firstName(b.recipientName) ? `For ${firstName(b.recipientName)} · ` : "")}${esc("CR" + b.number.split("/").pop())}${rider && live ? ` · ${esc(rider)} is your delivery partner` : ""}</p>
${code}
${b.status === "CANCELLED" || b.status === "FAILED" ? "" : `<div class="card">${steps}</div>`}
${live ? '<p class="note">This page updates by itself.</p>' : ""}`;
  res.send(page(body, live));
});

export default router;
