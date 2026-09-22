import { describe, it, expect } from "vitest";
import { periodWindow, periodOf, assertPeriod, RETURN_TYPES } from "../filedPeriods.js";

/**
 * Runbook step 18. The freeze itself is a property of a query meeting a filing record and a
 * cancellation timestamp — proven live by scripts/proveFiledPeriodFreeze.ts, which files a period,
 * cancels an order inside it and checks the number does not move. What is pinned here is the pure
 * arithmetic underneath it, because a window that is off by a day silently moves a reversal into
 * the wrong month and no screen would show it.
 */
describe("period windows", () => {
  it("is half-open, so a month ends exactly where the next begins", () => {
    // Closed-at-both-ends windows double-count the boundary instant, which is how one order lands
    // in two returns.
    const aug = periodWindow("2026-08");
    const sep = periodWindow("2026-09");
    expect(aug.end.getTime()).toBe(sep.start.getTime());
    expect(aug.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(aug.end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rolls December into the next January", () => {
    expect(periodWindow("2026-12").end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("handles February in a leap year without special-casing it", () => {
    // Date.UTC(y, m, 1) does the calendar; no day arithmetic to get wrong.
    expect(periodWindow("2028-02").end.toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });

  it("round-trips a date back to its own period", () => {
    for (const p of ["2026-01", "2026-08", "2026-12", "2027-02"]) {
      const { start, end } = periodWindow(p);
      expect(periodOf(start)).toBe(p);
      expect(periodOf(new Date(end.getTime() - 1))).toBe(p);
      // And the instant the window ends belongs to the NEXT period, not this one.
      expect(periodOf(end)).not.toBe(p);
    }
  });

  it("pads a single-digit month, so periods sort as strings", () => {
    // reversibleFiledPeriods compares periods with `<`, which only works lexicographically if every
    // period is the same width.
    expect(periodOf(new Date(Date.UTC(2026, 0, 15)))).toBe("2026-01");
    expect("2026-01" < "2026-09").toBe(true);
    expect("2026-09" < "2026-10").toBe(true);
  });
});

describe("period validation", () => {
  it("accepts YYYY-MM and nothing else", () => {
    expect(assertPeriod("2026-09")).toBe("2026-09");
    for (const bad of ["2026-9", "09-2026", "2026", "092026", "", "2026-13-01"]) {
      expect(() => assertPeriod(bad)).toThrow();
    }
  });
});

describe("return types", () => {
  it("keeps GSTR-1 and GSTR-8 independent", () => {
    // They are filed separately, on different dates, and can legitimately disagree about which
    // months are closed. One table, two keys — not one flag for both.
    expect(RETURN_TYPES.GSTR1).toBe("GSTR1");
    expect(RETURN_TYPES.GSTR8).toBe("GSTR8");
    expect(RETURN_TYPES.GSTR1).not.toBe(RETURN_TYPES.GSTR8);
  });
});
