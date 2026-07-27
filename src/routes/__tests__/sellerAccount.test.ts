import { describe, it, expect } from "vitest";
import { isKycLocked, overwritesVerifiedField } from "../sellerAccount.js";

describe("isKycLocked", () => {
  it("locks a currently-APPROVED seller", () => {
    expect(isKycLocked({ onboardingStatus: "APPROVED", everApproved: false })).toBe(true);
  });

  it("locks a legacy seller whose onboardingStatus already defaults to APPROVED", () => {
    // Every pre-Phase-1 Seller row reads this way — no backfill ever ran.
    expect(isKycLocked({ onboardingStatus: "APPROVED", everApproved: false })).toBe(true);
  });

  it("stays locked mid a change-request review, even though onboardingStatus moved away from APPROVED", () => {
    expect(isKycLocked({ onboardingStatus: "PENDING_REVIEW", everApproved: true })).toBe(true);
  });

  it("does not lock a seller who has never been approved", () => {
    expect(isKycLocked({ onboardingStatus: "IN_PROGRESS", everApproved: false })).toBe(false);
    expect(isKycLocked({ onboardingStatus: "PENDING_REVIEW", everApproved: false })).toBe(false);
    expect(isKycLocked({ onboardingStatus: "NOT_STARTED", everApproved: false })).toBe(false);
  });
});

describe("overwritesVerifiedField", () => {
  const current = { gstin: "27AAAAA1111A1ZW", pan: "AAAAA1111A", bankDetails: { accountNumber: "123" } };

  it("ignores fields not present in the request (a partial save)", () => {
    expect(overwritesVerifiedField({ shopAddress: "new address" }, current)).toBe(false);
  });

  it("ignores a field resubmitted with its own unchanged value", () => {
    expect(overwritesVerifiedField({ gstin: current.gstin }, current)).toBe(false);
  });

  it("catches a genuine GSTIN change", () => {
    expect(overwritesVerifiedField({ gstin: "09ABCDE1234F2ZX" }, current)).toBe(true);
  });

  it("deep-compares the bankDetails object, not just presence", () => {
    expect(overwritesVerifiedField({ bankDetails: { accountNumber: "123" } }, current)).toBe(false);
    expect(overwritesVerifiedField({ bankDetails: { accountNumber: "999" } }, current)).toBe(true);
  });

  it("compares Date-typed fssaiExpiry by instant, not object identity", () => {
    const a = { ...current, fssaiExpiry: new Date("2027-01-01") };
    expect(overwritesVerifiedField({ fssaiExpiry: new Date("2027-01-01") }, a)).toBe(false);
    expect(overwritesVerifiedField({ fssaiExpiry: new Date("2027-06-01") }, a)).toBe(true);
  });

  it("exempts filling in a field that was genuinely blank — nothing verified there to protect", () => {
    const blank = { ...current, pan: null };
    expect(overwritesVerifiedField({ pan: "AAAAA1111A" }, blank)).toBe(false);
  });

  it("treats a stored empty string the same as null (also exempt)", () => {
    const blank = { ...current, gstin: "" };
    expect(overwritesVerifiedField({ gstin: "09ABCDE1234F2ZX" }, blank)).toBe(false);
  });

  it("still catches clearing an existing value — a clear is itself an overwrite", () => {
    expect(overwritesVerifiedField({ gstin: null }, current)).toBe(true);
  });
});
