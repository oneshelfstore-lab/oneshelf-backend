import { describe, it, expect } from "vitest";
import { isPhonelessAllowedPath } from "../firebaseAuth.js";

/**
 * Pure-function tests for the phone-on-file gate's allowlist (no Express/Prisma mocking — matches
 * this repo's convention of only unit-testing the extracted pure parts).
 *
 * Both failure modes here are SILENT in production: an over-broad entry quietly re-opens the
 * endpoints the gate exists to close, and an over-narrow one strands a customer on a setup screen
 * whose own save call is being 403'd.
 */
describe("isPhonelessAllowedPath", () => {
  it("allows the profile endpoint itself (how a phone actually gets added)", () => {
    expect(isPhonelessAllowedPath("/api/app/me")).toBe(true);
  });

  it("allows consents, fcm-token and referral sub-paths", () => {
    expect(isPhonelessAllowedPath("/api/app/me/consents")).toBe(true);
    expect(isPhonelessAllowedPath("/api/app/me/fcm-token")).toBe(true);
    expect(isPhonelessAllowedPath("/api/app/me/referral")).toBe(true);
    expect(isPhonelessAllowedPath("/api/app/me/referral/apply")).toBe(true);
  });

  // The whole point of the gate. `/api/app/me` must be an EXACT match, never a prefix.
  it("BLOCKS /me sub-resources that /api/app/me must not re-open as a prefix", () => {
    expect(isPhonelessAllowedPath("/api/app/me/wallet")).toBe(false);
    expect(isPhonelessAllowedPath("/api/app/me/orders")).toBe(false);
    expect(isPhonelessAllowedPath("/api/app/me/data-export")).toBe(false);
    expect(isPhonelessAllowedPath("/api/app/me/complaints")).toBe(false);
  });

  it("blocks the transacting endpoints", () => {
    expect(isPhonelessAllowedPath("/api/app/orders")).toBe(false);
    expect(isPhonelessAllowedPath("/api/app/cart")).toBe(false);
    expect(isPhonelessAllowedPath("/api/app/cart/quote")).toBe(false);
    expect(isPhonelessAllowedPath("/api/app/subscriptions")).toBe(false);
  });

  it("ignores the query string", () => {
    expect(isPhonelessAllowedPath("/api/app/me?fresh=1")).toBe(true);
    expect(isPhonelessAllowedPath("/api/app/me/wallet?page=1")).toBe(false);
  });

  it("tolerates a trailing slash", () => {
    expect(isPhonelessAllowedPath("/api/app/me/")).toBe(true);
    expect(isPhonelessAllowedPath("/api/app/me/consents/")).toBe(true);
  });

  // A prefix entry must match on a path SEGMENT, not a bare string prefix — otherwise a route
  // like /me/referral-payouts would inherit /me/referral's allowance.
  it("does not let a prefix leak into a longer sibling segment", () => {
    expect(isPhonelessAllowedPath("/api/app/me/referral-payouts")).toBe(false);
    expect(isPhonelessAllowedPath("/api/app/me/consents-export")).toBe(false);
    expect(isPhonelessAllowedPath("/api/app/mextra")).toBe(false);
  });
});
