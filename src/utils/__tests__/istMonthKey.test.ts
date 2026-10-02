import { describe, it, expect } from "vitest";
import { istMonthKey } from "../istMonthKey.js";

describe("istMonthKey", () => {
  it("formats a UTC date as its IST calendar month", () => {
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
