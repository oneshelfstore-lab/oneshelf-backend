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

// 0 = every order gets a handover code. Was ₹500 (and ₹2000 before that), which left the cheapest,
// most-disputed orders completing with no proof of handover at all.
export const OTP_MIN_ORDER_TOTAL = 0;

/**
 * True ⇒ this order must be OTP-verified at handover. Now unconditional for every customer-placed
 * order regardless of value or payment method.
 *
 * ⚠️ Subscription orders are the one exception and it is NOT here — subscriptionEngine.ts hardcodes
 * `deliveryOtpRequired: false`, because the daily run is delivered as a batch
 * (POST /subscription-run/deliver-all) and a per-drop code would break that flow.
 */
export function orderRequiresOtp(_paymentStatus: string, total: number): boolean {
  return total >= OTP_MIN_ORDER_TOTAL;
}

// After maxAttempts wrong entries the code is locked for a cooldown window (then the attempt
// counter resets) instead of being permanently bricked. The OWNER is exempt from the lock so a
// jammed order can always be completed by the store.
export const OTP_LOCK_SECONDS = 60;

// The handover code is only revealed to the customer once the order is actually on its way (out
// for delivery) or ready at the counter (pickup) — i.e. handover is imminent. It stays hidden
// while PLACED/CONFIRMED/PACKED so it can't be seen (or screenshotted) long before it's needed.
export const OTP_VISIBLE_STATUSES = ["OUT_FOR_DELIVERY", "READY_FOR_PICKUP"];
