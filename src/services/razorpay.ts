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
