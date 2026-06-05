import { describe, it, expect } from "vitest";
import { getCurrentFinancialYear } from "../invoiceNumbering.js";

// Note: getNextInvoiceNumber requires a live DB connection, so we test the
// pure utility function here. Integration tests for the DB-backed numbering
// should run against a test database.

describe("getCurrentFinancialYear", () => {
  it("April → same year FY", () => {
    // April 2026 → FY 2026-27 → "2627"
    expect(getCurrentFinancialYear(new Date(2026, 3, 1))).toBe("2627");
  });

  it("June → same year FY", () => {
    // June 2026 → FY 2026-27 → "2627"
    expect(getCurrentFinancialYear(new Date(2026, 5, 15))).toBe("2627");
  });

  it("December → same year FY", () => {
    // Dec 2026 → FY 2026-27 → "2627"
    expect(getCurrentFinancialYear(new Date(2026, 11, 31))).toBe("2627");
  });

  it("January → previous year FY", () => {
    // Jan 2027 → FY 2026-27 → "2627"
    expect(getCurrentFinancialYear(new Date(2027, 0, 15))).toBe("2627");
  });

  it("February → previous year FY", () => {
    // Feb 2027 → FY 2026-27 → "2627"
    expect(getCurrentFinancialYear(new Date(2027, 1, 28))).toBe("2627");
  });

  it("March 31 → still previous year FY", () => {
    // March 31, 2027 → FY 2026-27 → "2627"
    expect(getCurrentFinancialYear(new Date(2027, 2, 31))).toBe("2627");
  });

  it("April 1 → rolls to new FY", () => {
    // April 1, 2027 → FY 2027-28 → "2728"
    expect(getCurrentFinancialYear(new Date(2027, 3, 1))).toBe("2728");
  });

  it("century boundary", () => {
    // April 2099 → FY 2099-2100 → "9900"
    expect(getCurrentFinancialYear(new Date(2099, 3, 1))).toBe("9900");
  });

  it("multiple FY types don't interfere (pure function — no state)", () => {
    const date = new Date(2026, 5, 1); // June 2026
    // Calling multiple times with same date gives same result
    expect(getCurrentFinancialYear(date)).toBe("2627");
    expect(getCurrentFinancialYear(date)).toBe("2627");
  });
});
