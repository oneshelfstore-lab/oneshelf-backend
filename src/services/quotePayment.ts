import prisma from "../lib/prisma.js";
import { fetchCapturedPaymentForOrder, isRazorpayConfigured } from "./razorpay.js";

// ─── Bulk-quote payment confirmation ──────────────────────────────────────
// Mirrors services/orderPayment.ts + paymentReconciliation.ts, but for a QuoteRequest that the
// customer approved with online payment. One idempotent confirmation path (markQuotePaid) is fed by
// THREE sources, exactly like orders: (1) the app's POST /me/quote-requests/:id/pay, (2) the Razorpay
// webhook (creditQuoteByRazorpayOrder), and (3) reconciliation on app-reopen / a periodic sweep
// (reconcileQuotePayment). So a killed/offline app mid-payment can never strand a captured payment.

/** Advance % charged now for a "pay advance" approval. The rest is collected on delivery. */
export async function getQuoteAdvancePercent(): Promise<number> {
  const cfg = await prisma.storeConfig.findFirst({ select: { quoteAdvancePercent: true } });
  const pct = cfg?.quoteAdvancePercent ?? 10;
  return Math.min(100, Math.max(1, pct));
}

/** The ₹ amount to charge online for an approval, given the grand total + the chosen option. */
export function computeQuoteCharge(total: number, paymentOption: string, advancePercent: number): number {
  if (paymentOption === "ADVANCE") {
    return Math.max(1, Math.round((total * advancePercent) / 100));
  }
  return Math.round(total);
}

export interface QuoteReconcileResult {
  quoteId: string;
  paymentStatus: string; // UNPAID | PAID | ADVANCE_PAID | UNKNOWN
  changed: boolean;
}

/**
 * Confirms a quote's online payment. Idempotent via a guarded UNPAID→(PAID|ADVANCE_PAID) flip:
 * concurrent confirmations (the app's /pay AND the webhook) race on updateMany WHERE
 * paymentStatus=UNPAID; only the winner (count===1) records the captured amount + flips status to
 * ACCEPTED. Returns true if THIS call applied the confirmation.
 */
export async function markQuotePaid(quoteId: string, razorpayPaymentId: string): Promise<boolean> {
  const quote = await prisma.quoteRequest.findUnique({
    where: { id: quoteId },
    select: { id: true, quotedAmount: true, paymentOption: true, paymentStatus: true },
  });
  if (!quote || quote.paymentStatus !== "UNPAID") return false;

  const total = quote.quotedAmount != null ? Number(quote.quotedAmount) : 0;
  const option = quote.paymentOption === "ADVANCE" ? "ADVANCE" : "FULL";
  const advancePercent = option === "ADVANCE" ? await getQuoteAdvancePercent() : 0;
  const charged = computeQuoteCharge(total, option, advancePercent);
  const newPaymentStatus = option === "ADVANCE" ? "ADVANCE_PAID" : "PAID";

  const flip = await prisma.quoteRequest.updateMany({
    where: { id: quoteId, paymentStatus: "UNPAID" },
    data: {
      paymentStatus: newPaymentStatus,
      amountPaid: charged,
      status: "ACCEPTED",
      razorpayPaymentId,
    },
  });
  if (flip.count !== 1) return false;

  // Bulk Express: the paid quote is now ACCEPTED → materialize the fulfillment Order (delivery
  // pipeline + invoice + OTP). Best-effort + idempotent, so the concurrent /pay-vs-webhook winner
  // creates exactly one order and a failure here never reverts a confirmed payment.
  try {
    const { materializeQuoteOrder } = await import("./quoteToOrder.js");
    await materializeQuoteOrder(quoteId);
  } catch (convErr) {
    console.warn("materializeQuoteOrder (paid) failed:", convErr);
  }
  return true;
}

/** Webhook/reconcile entry: confirm a quote identified by its Razorpay order id. No-op if unknown. */
export async function creditQuoteByRazorpayOrder(
  razorpayOrderId: string,
  razorpayPaymentId: string,
): Promise<boolean> {
  const quote = await prisma.quoteRequest.findFirst({
    where: { razorpayOrderId },
    select: { id: true },
  });
  if (!quote) return false;
  return markQuotePaid(quote.id, razorpayPaymentId);
}

/**
 * Reconciles a single quote's payment against Razorpay's API — the recovery for a payment captured
 * but whose confirmation never reached us. For an UNPAID quote with a razorpayOrderId, ask Razorpay
 * whether a payment was actually captured; if so, confirm via the shared idempotent path. Safe +
 * idempotent: no-op for unconfigured-Razorpay / already-paid / no-captured-payment.
 */
export async function reconcileQuotePayment(quoteId: string): Promise<QuoteReconcileResult> {
  const quote = await prisma.quoteRequest.findUnique({
    where: { id: quoteId },
    select: { id: true, paymentStatus: true, razorpayOrderId: true },
  });
  if (!quote) return { quoteId, paymentStatus: "UNKNOWN", changed: false };
  if (!quote.razorpayOrderId || !isRazorpayConfigured()) {
    return { quoteId, paymentStatus: quote.paymentStatus, changed: false };
  }
  if (quote.paymentStatus !== "UNPAID") {
    return { quoteId, paymentStatus: quote.paymentStatus, changed: false };
  }

  let captured;
  try {
    captured = await fetchCapturedPaymentForOrder(quote.razorpayOrderId);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "quote reconcile fetch failed", quoteId, err: String(e) }));
    return { quoteId, paymentStatus: quote.paymentStatus, changed: false };
  }
  if (!captured) {
    return { quoteId, paymentStatus: quote.paymentStatus, changed: false };
  }

  const changed = await markQuotePaid(quote.id, captured.id);
  const fresh = await prisma.quoteRequest.findUnique({
    where: { id: quote.id },
    select: { paymentStatus: true },
  });
  return { quoteId, paymentStatus: fresh?.paymentStatus ?? "PAID", changed };
}

/**
 * Periodic sweep: any quote that was approved-with-online-payment (razorpayOrderId set) but is still
 * UNPAID after a grace window is reconciled against Razorpay — recovering a payment whose /pay
 * confirmation never arrived. Unlike orders we do NOT cancel anything (an unpaid quote just stays
 * QUOTED, awaiting the customer); this only RECOVERS real payments. No-op without Razorpay configured.
 */
export async function reconcileStaleUnpaidQuotes(): Promise<number> {
  if (!isRazorpayConfigured()) return 0;
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const stale = await prisma.quoteRequest.findMany({
    where: {
      paymentStatus: "UNPAID",
      razorpayOrderId: { not: null },
      createdAt: { lt: cutoff },
    },
    select: { id: true },
  });
  let recovered = 0;
  for (const q of stale) {
    try {
      const r = await reconcileQuotePayment(q.id);
      if (r.changed) recovered++;
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "quote reconcile sweep item failed", quoteId: q.id, err: String(err) }));
    }
  }
  if (recovered > 0) {
    console.log(JSON.stringify({ level: "info", msg: "recovered stranded quote payments", count: recovered }));
  }
  return recovered;
}

/** Starts the in-process quote-payment reconcile sweeper (single-instance; same caveat as orders). */
export function startQuotePaymentSweeper(intervalMs = 5 * 60 * 1000): void {
  const timer = setInterval(() => {
    reconcileStaleUnpaidQuotes().catch((e) =>
      console.error(JSON.stringify({ level: "error", msg: "quote reconcile sweep crashed", err: String(e) })),
    );
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
