import { describe, it, expect } from "vitest";
import { istMinutesOfDay, parseHhMm, isRestaurantOpen } from "../foodMenu.js";

// Fixed instants, expressed in UTC. IST = UTC+5:30.
const at = (utcHour: number, utcMin = 0) =>
  new Date(Date.UTC(2026, 8, 2, utcHour, utcMin, 0));

describe("parseHhMm", () => {
  it("parses a real wall clock", () => {
    expect(parseHhMm("00:00")).toBe(0);
    expect(parseHhMm("10:00")).toBe(600);
    expect(parseHhMm("23:59")).toBe(1439);
    expect(parseHhMm(" 9:05 ")).toBe(545);
  });

  it("rejects anything that isn't HH:MM", () => {
    for (const bad of [null, undefined, "", "10", "10:0", "24:00", "10:60", "abc", "1000"]) {
      expect(parseHhMm(bad as string | null)).toBeNull();
    }
  });
});

describe("istMinutesOfDay", () => {
  it("shifts UTC by +5:30", () => {
    expect(istMinutesOfDay(at(0, 0))).toBe(330); // 05:30 IST
    expect(istMinutesOfDay(at(6, 30))).toBe(720); // 12:00 IST
  });

  it("wraps past UTC midnight instead of going negative", () => {
    // 20:00 UTC is 01:30 IST the NEXT day — the case a naive add would push past 1440.
    expect(istMinutesOfDay(at(20, 0))).toBe(90);
  });
});

describe("isRestaurantOpen", () => {
  it("treats unset hours as OPEN, never closed", () => {
    // The regression this guards is silent: failing closed hides a live restaurant with nothing
    // on screen explaining why.
    expect(isRestaurantOpen(null, null, at(20, 0))).toBe(true);
    expect(isRestaurantOpen("10:00", null, at(20, 0))).toBe(true);
    expect(isRestaurantOpen(null, "23:00", at(20, 0))).toBe(true);
    expect(isRestaurantOpen("bad", "worse", at(20, 0))).toBe(true);
  });

  it("handles a normal same-day window", () => {
    // 10:00–23:00 IST
    expect(isRestaurantOpen("10:00", "23:00", at(6, 30))).toBe(true); // 12:00 IST
    expect(isRestaurantOpen("10:00", "23:00", at(2, 0))).toBe(false); // 07:30 IST
    expect(isRestaurantOpen("10:00", "23:00", at(20, 0))).toBe(false); // 01:30 IST
  });

  it("handles a past-midnight close as a window, not bad data", () => {
    // 18:00–02:00 IST — the normal dinner-service case, and the one a naive open<close check breaks.
    expect(isRestaurantOpen("18:00", "02:00", at(20, 0))).toBe(true); // 01:30 IST
    expect(isRestaurantOpen("18:00", "02:00", at(14, 0))).toBe(true); // 19:30 IST
    expect(isRestaurantOpen("18:00", "02:00", at(6, 30))).toBe(false); // 12:00 IST
  });

  it("is inclusive of the open minute and exclusive of the close minute", () => {
    expect(isRestaurantOpen("10:00", "23:00", at(4, 30))).toBe(true); // exactly 10:00 IST
    expect(isRestaurantOpen("10:00", "23:00", at(17, 30))).toBe(false); // exactly 23:00 IST
  });

  it("treats open == close as 24 hours", () => {
    expect(isRestaurantOpen("00:00", "00:00", at(20, 0))).toBe(true);
  });
});
