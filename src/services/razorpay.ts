import crypto from "crypto";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn("WARNING: Razorpay keys not configured. Online payments will fail. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env");
}

interface RazorpayOrderResponse {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

export async function createRazorpayOrder(
  amountInPaise: number,
  receipt: string,
): Promise<RazorpayOrderResponse> {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay not configured");
  }

  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");

  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      amount: amountInPaise,
      currency: "INR",
      receipt,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Razorpay order creation failed: ${err}`);
  }

  return response.json() as Promise<RazorpayOrderResponse>;
}

export function verifyPaymentSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string,
): boolean {
  if (!RAZORPAY_KEY_SECRET) return false;

  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac("sha256", RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");

  // Constant-time comparison to avoid leaking signature bytes via timing.
  const expectedBuf = Buffer.from(expectedSignature, "hex");
  const receivedBuf = Buffer.from(String(razorpaySignature || ""), "hex");
  return (
    expectedBuf.length === receivedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, receivedBuf)
  );
}

export function isRazorpayConfigured(): boolean {
  return !!RAZORPAY_KEY_ID && !!RAZORPAY_KEY_SECRET;
}

export interface RazorpayPayment {
  id: string;
  status: string; // created | authorized | captured | refunded | failed
  amount: number;
  order_id: string;
}

/**
 * Fetches the payments Razorpay recorded against an order and returns the captured one (if any).
 * This is the server-to-server source of truth used by reconciliation and the safe expiry sweeper
 * to answer "was this order actually paid?" — independent of whether the mobile app ever called /pay
 * (so a crashed/killed app can't strand a real payment). Returns null when nothing was captured.
 */
export async function fetchCapturedPaymentForOrder(
  razorpayOrderId: string,
): Promise<RazorpayPayment | null> {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay not configured");
  }
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");

  const response = await fetch(
    `https://api.razorpay.com/v1/orders/${encodeURIComponent(razorpayOrderId)}/payments`,
    { method: "GET", headers: { Authorization: `Basic ${auth}` } },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Razorpay fetch-payments failed: ${err}`);
  }

  const data = (await response.json()) as { items?: RazorpayPayment[] };
  return (data.items ?? []).find((p) => p.status === "captured") ?? null;
}

/**
 * Verifies a Razorpay WEBHOOK signature. Razorpay signs the RAW request body with the webhook
 * secret (NOT the API key secret) using HMAC-SHA256. Constant-time compare.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(String(signature || ""), "hex");
  return (
    expectedBuf.length === receivedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, receivedBuf)
  );
}

/**
 * Refunds a captured Razorpay payment. Pass amountInPaise for a partial refund;
 * omit for a full refund. Throws on failure so the caller can record the outcome.
 */
export async function refundPayment(
  paymentId: string,
  amountInPaise?: number,
): Promise<{ id: string; status: string }> {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay not configured");
  }
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");

  const response = await fetch(
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(amountInPaise ? { amount: amountInPaise } : {}),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Razorpay refund failed: ${err}`);
  }

  return response.json() as Promise<{ id: string; status: string }>;
}
