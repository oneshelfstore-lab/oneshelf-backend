import { randomInt } from "crypto";

/**
 * Delivery handover OTP — the single source of truth for the code's length, entropy, and the
 * policy for when an order needs one. Previously each of these was duplicated (with the weaker
 * `Math.random()`) across orders.ts / orderPayment.ts / quoteToOrder.ts; centralising means a
 * change to length or policy lands everywhere at once and can't silently regress.
 */

// 6-digit, cryptographically random (100000..999999). crypto.randomInt is uniform + unpredictable,
// unlike Math.random() (a seeded PRNG). Brute space is 900,000 vs the old 9,000.
export function generateOtp(): string {
  return String(randomInt(100000, 1000000));
}

// Every delivery/pickup order at or above this value gets a handover code — regardless of payment
// method (COD, prepaid, or advance-paid). Closes the old gap where COD orders ≤ ₹2000 had none.
export const OTP_MIN_ORDER_TOTAL = 500;

/**
 * True ⇒ this order must be OTP-verified at handover. Prepaid / advance-paid always require one
 * (money already captured); everything else is gated purely on order value.
 */
export function orderRequiresOtp(paymentStatus: string, total: number): boolean {
  if (paymentStatus === "PAID" || paymentStatus === "ADVANCE_PAID") return true;
  return total >= OTP_MIN_ORDER_TOTAL;
}

// After maxAttempts wrong entries the code is locked for a cooldown window (then the attempt
// counter resets) instead of being permanently bricked. The OWNER is exempt from the lock so a
// jammed order can always be completed by the store.
export const OTP_LOCK_SECONDS = 60;
