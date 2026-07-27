import { describe, it, expect } from "vitest";
import { isValidGstin, extractPanFromGstin } from "../index.js";

/**
 * Pins the GSTIN format + checksum rules. The regression that prompted these: the entity character
 * (position 13) was matched as `\d`, which silently rejected the GENUINE GSTIN of any business with
 * 10 or more registrations under one PAN in one state — that counter rolls 1-9 then A-Z.
 *
 * Check digits below are the real mod-36 weighted values, so these double as a checksum test: flip
 * any single character in a passing case and it stops validating.
 */
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The check character the algorithm requires for a given 14-char prefix. */
function checkDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
}
const withCheck = (first14: string) => first14 + checkDigit(first14);

describe("isValidGstin", () => {
  it("accepts a well-formed GSTIN with a numeric entity counter", () => {
    expect(isValidGstin(withCheck("09ABCDE1234F2Z")).valid).toBe(true);
    expect(isValidGstin(withCheck("27AAACI1195H1Z")).valid).toBe(true);
  });

  // The actual bug: entity counters roll over to letters after the 9th registration.
  it("accepts a letter entity counter (10th+ registration on one PAN in one state)", () => {
    expect(isValidGstin(withCheck("09ABCDE1234FAZ")).valid).toBe(true);
    expect(isValidGstin(withCheck("09ABCDE1234FZZ")).valid).toBe(true);
  });

  it("rejects entity counter 0 — registrations are numbered from 1", () => {
    expect(isValidGstin(withCheck("09ABCDE1234F0Z")).valid).toBe(false);
  });

  it("rejects a wrong check digit even when the shape is right", () => {
    const good = withCheck("09ABCDE1234F2Z");
    const bad = good.slice(0, 14) + (good[14] === "X" ? "5" : "X");
    expect(isValidGstin(good).valid).toBe(true);
    expect(isValidGstin(bad).valid).toBe(false);
    expect(isValidGstin(bad).error).toMatch(/checksum/i);
  });

  it("rejects wrong length and a missing Z in position 14", () => {
    expect(isValidGstin("09ABCDE1234F2Z").valid).toBe(false); // 14 chars
    expect(isValidGstin(withCheck("09ABCDE1234F2Y")).valid).toBe(false);
  });

  it("rejects a malformed PAN segment", () => {
    expect(isValidGstin(withCheck("09ABCD12345F2Z")).valid).toBe(false); // digit inside the letters
    expect(isValidGstin(withCheck("0XABCDE1234F2Z")).valid).toBe(false); // non-numeric state code
  });

  it("extracts the PAN from positions 3-12", () => {
    expect(extractPanFromGstin(withCheck("09ABCDE1234F2Z"))).toBe("ABCDE1234F");
  });
});
