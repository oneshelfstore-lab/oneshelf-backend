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

// ─── F1: closed by hand, timed reopen, timed 86 ─────────────────────────────────────────────────
import { isKitchenClosed, isKitchenOpen, isTempUnavailable, nextIstOccurrence } from "../foodMenu.js";

describe("isKitchenClosed", () => {
  const closedAt = at(10);
  it("is open when never closed", () => {
    expect(isKitchenClosed(null, null, at(12))).toBe(false);
  });
  it("stays closed with no reopen time (manual reopen only)", () => {
    expect(isKitchenClosed(closedAt, null, at(20))).toBe(true);
  });
  it("reopens by itself once the timer passes, and not a minute before", () => {
    const reopen = at(11);
    expect(isKitchenClosed(closedAt, reopen, at(10, 59))).toBe(true);
    expect(isKitchenClosed(closedAt, reopen, at(11))).toBe(false);
  });
  it("ignores a STALE reopenAt left over from an earlier closure", () => {
    // Closed again at 15:00; the old timer said 11:00. Reading it as "already reopened" would let a
    // freshly closed kitchen keep taking orders.
    expect(isKitchenClosed(at(15), at(11), at(16))).toBe(true);
  });
});

describe("isKitchenOpen", () => {
  it("needs BOTH the usual hours and no manual close", () => {
    const base = { openTime: "10:00", closeTime: "23:00", closedSince: null, reopenAt: null };
    expect(isKitchenOpen(base, at(8))).toBe(true); // 13:30 IST
    expect(isKitchenOpen({ ...base, closedSince: at(7) }, at(8))).toBe(false);
    expect(isKitchenOpen(base, at(20))).toBe(false); // 01:30 IST, outside hours
  });
});

describe("isTempUnavailable", () => {
  it("is true only while the timer is in the future", () => {
    expect(isTempUnavailable(null, at(10))).toBe(false);
    expect(isTempUnavailable(at(11), at(10))).toBe(true);
    expect(isTempUnavailable(at(11), at(11))).toBe(false);
  });
});

describe("nextIstOccurrence", () => {
  it("finds the next time that wall clock reads, today or tomorrow", () => {
    // 08:00 UTC = 13:30 IST. 23:00 IST today is 17:30 UTC.
    expect(nextIstOccurrence("23:00", at(8)).toISOString()).toBe("2026-09-02T17:30:00.000Z");
    // Already past 11:00 IST -> tomorrow's 11:00 IST = 05:30 UTC next day.
    expect(nextIstOccurrence("11:00", at(8)).toISOString()).toBe("2026-09-03T05:30:00.000Z");
  });
  it("is strictly in the future, even asked exactly on the minute", () => {
    expect(nextIstOccurrence("13:30", at(8)).toISOString()).toBe("2026-09-03T08:00:00.000Z");
  });
  it("falls back to IST midnight when blank", () => {
    expect(nextIstOccurrence(null, at(8)).toISOString()).toBe("2026-09-02T18:30:00.000Z");
  });
});

import { normaliseFoodType } from "../foodMenu.js";
describe("normaliseFoodType", () => {
  it("derives isVeg from foodType, so an old build never sees egg as veg", () => {
    expect(normaliseFoodType({ foodType: "EGG" })).toEqual({ foodType: "EGG", isVeg: false });
    expect(normaliseFoodType({ foodType: "VEG" })).toEqual({ foodType: "VEG", isVeg: true });
  });
  it("maps an old client's isVeg to a foodType", () => {
    expect(normaliseFoodType({ isVeg: false })).toEqual({ isVeg: false, foodType: "NON_VEG" });
  });
  it("leaves a partial update that mentions neither alone", () => {
    expect(normaliseFoodType({})).toEqual({});
  });
});
