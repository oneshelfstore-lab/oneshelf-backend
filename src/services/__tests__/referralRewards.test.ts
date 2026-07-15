import { describe, it, expect } from "vitest";
import { round2, istMonthKey, isPastCommissionWindow } from "../referralRewards.js";

// Note: accrueReferralCommission/closeMonthlyReferralPayouts require a live DB connection, so we
// test the pure calculation/window functions here (matches this repo's invoiceNumbering.test.ts
// pattern for pure-function-only coverage).

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(12.345)).toBe(12.35);
    expect(round2(12.344)).toBe(12.34);
  });

  it("handles floating-point drift (1% commission on odd subtotals)", () => {
    expect(round2((299.99 * 1) / 100)).toBe(3);
  });
});

describe("istMonthKey", () => {
  it("formats a UTC date as its IST calendar month", () => {
    // 2026-07-15 18:30 UTC = 2026-07-16 00:00 IST → rolls into July still
    expect(istMonthKey(new Date("2026-07-15T18:30:00Z"))).toBe("2026-07");
  });

  it("crosses into the next IST month near midnight", () => {
    // 2026-07-31 19:00 UTC = 2026-08-01 00:30 IST
    expect(istMonthKey(new Date("2026-07-31T19:00:00Z"))).toBe("2026-08");
  });

  it("pads single-digit months", () => {
    expect(istMonthKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });
});

describe("isPastCommissionWindow", () => {
  const anchor = new Date("2026-01-15T00:00:00Z");

  it("within the window → false", () => {
    expect(isPastCommissionWindow(anchor, 12, new Date("2026-06-01T00:00:00Z"))).toBe(false);
  });

  it("exactly at the cutoff → not yet past", () => {
    expect(isPastCommissionWindow(anchor, 12, new Date("2027-01-15T00:00:00Z"))).toBe(false);
  });

  it("past the cutoff → true", () => {
    expect(isPastCommissionWindow(anchor, 12, new Date("2027-01-16T00:00:00Z"))).toBe(true);
  });

  it("months <= 0 means no cap", () => {
    expect(isPastCommissionWindow(anchor, 0, new Date("2099-01-01T00:00:00Z"))).toBe(false);
  });
});
