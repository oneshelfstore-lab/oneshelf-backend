import { describe, it, expect } from "vitest";
import { orderRequiresOtp, generateOtp } from "../otp.js";

/**
 * Pins "every order needs a handover PIN". This used to be value-gated (₹2000, then ₹500), and the
 * failure mode of a regression is silent: orders simply complete with no proof of handover and
 * nothing anywhere says a code was skipped. A ₹1 order must still require one.
 */
describe("orderRequiresOtp", () => {
  it("requires a code on every order, regardless of value", () => {
    for (const total of [0, 1, 18, 499, 500, 5000]) {
      expect(orderRequiresOtp("PENDING", total)).toBe(true);
    }
  });

  it("requires a code regardless of payment status", () => {
    for (const status of ["PENDING", "PAID", "ADVANCE_PAID", "REFUNDED"]) {
      expect(orderRequiresOtp(status, 18)).toBe(true);
    }
  });
});

describe("generateOtp", () => {
  it("is always 6 digits", () => {
    for (let i = 0; i < 200; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });
});
