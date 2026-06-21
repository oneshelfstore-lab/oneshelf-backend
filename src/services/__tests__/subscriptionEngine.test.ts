import { describe, it, expect, afterEach, vi } from "vitest";
import {
  istMidnight,
  isValidDeliveryDay,
  computeNextDeliveryDate,
  firstDeliveryOnOrAfter,
  upcomingDates,
  priceSubscriptionDelivery,
  type CadenceLike,
} from "../subscriptionEngine.js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// An IST calendar day → its IST-midnight-in-UTC instant (noon UTC is safely inside the IST day).
function day(y: number, m: number, d: number): Date {
  return istMidnight(new Date(Date.UTC(y, m - 1, d, 12)));
}
function weekdayOf(dt: Date): number {
  return new Date(dt.getTime() + IST_OFFSET_MS).getUTCDay();
}
function base(overrides: Partial<CadenceLike>): CadenceLike {
  return {
    frequency: "DAILY",
    intervalDays: null,
    daysOfWeek: [],
    dayOfMonth: null,
    startDate: day(2026, 6, 1),
    endDate: null,
    ...overrides,
  };
}

describe("DAILY cadence", () => {
  const sub = base({ frequency: "DAILY" });
  it("every day is a valid delivery day", () => {
    expect(isValidDeliveryDay(sub, day(2026, 6, 15))).toBe(true);
  });
  it("next delivery = +1 day", () => {
    expect(computeNextDeliveryDate(sub, day(2026, 6, 15)).getTime()).toBe(day(2026, 6, 16).getTime());
  });
  it("firstDeliveryOnOrAfter includes the day itself when valid", () => {
    expect(firstDeliveryOnOrAfter(sub, day(2026, 6, 15)).getTime()).toBe(day(2026, 6, 15).getTime());
  });
});

describe("WEEKLY cadence", () => {
  it("single weekday → next matching weekday", () => {
    const wd = weekdayOf(day(2026, 6, 18));
    const sub = base({ frequency: "WEEKLY", daysOfWeek: [wd] });
    expect(isValidDeliveryDay(sub, day(2026, 6, 18))).toBe(true);
    expect(isValidDeliveryDay(sub, day(2026, 6, 17))).toBe(false);
    // From the 15th, the next (and only) matching weekday within the week is the 18th.
    expect(computeNextDeliveryDate(sub, day(2026, 6, 15)).getTime()).toBe(day(2026, 6, 18).getTime());
  });
  it("two weekdays → wraps to next week after the last", () => {
    const wdA = weekdayOf(day(2026, 6, 16));
    const wdB = weekdayOf(day(2026, 6, 19));
    const sub = base({ frequency: "WEEKLY", daysOfWeek: [wdA, wdB] });
    expect(computeNextDeliveryDate(sub, day(2026, 6, 16)).getTime()).toBe(day(2026, 6, 19).getTime());
    // After the later weekday, the next is wdA in the following week (the 16th + 7 = 23rd).
    expect(computeNextDeliveryDate(sub, day(2026, 6, 19)).getTime()).toBe(day(2026, 6, 23).getTime());
  });
});

describe("MONTHLY cadence", () => {
  const sub = base({ frequency: "MONTHLY", dayOfMonth: 28 });
  it("only the dayOfMonth is valid", () => {
    expect(isValidDeliveryDay(sub, day(2026, 6, 28))).toBe(true);
    expect(isValidDeliveryDay(sub, day(2026, 6, 27))).toBe(false);
  });
  it("rolls to the same day next month", () => {
    expect(computeNextDeliveryDate(sub, day(2026, 6, 10)).getTime()).toBe(day(2026, 6, 28).getTime());
    expect(computeNextDeliveryDate(sub, day(2026, 6, 28)).getTime()).toBe(day(2026, 7, 28).getTime());
  });
  it("month-end safe: the 28th exists in February", () => {
    expect(computeNextDeliveryDate(sub, day(2026, 2, 10)).getTime()).toBe(day(2026, 2, 28).getTime());
    expect(computeNextDeliveryDate(sub, day(2026, 2, 28)).getTime()).toBe(day(2026, 3, 28).getTime());
  });
});

describe("CUSTOM cadence", () => {
  const sub = base({ frequency: "CUSTOM", intervalDays: 3, startDate: day(2026, 6, 1) });
  it("valid only on multiples of the interval from startDate", () => {
    expect(isValidDeliveryDay(sub, day(2026, 6, 1))).toBe(true); // diff 0
    expect(isValidDeliveryDay(sub, day(2026, 6, 4))).toBe(true); // diff 3
    expect(isValidDeliveryDay(sub, day(2026, 6, 5))).toBe(false); // diff 4
  });
  it("next jumps to the next interval boundary", () => {
    expect(computeNextDeliveryDate(sub, day(2026, 6, 1)).getTime()).toBe(day(2026, 6, 4).getTime());
    expect(computeNextDeliveryDate(sub, day(2026, 6, 2)).getTime()).toBe(day(2026, 6, 4).getTime());
  });
});

describe("catch-up / resync (computeNextDeliveryDate from a stale past cursor)", () => {
  it("DAILY: from a missed past day returns the very next day (cursor resyncs forward)", () => {
    const sub = base({ frequency: "DAILY" });
    // Cursor stale 3 days ago → next valid day after it.
    expect(computeNextDeliveryDate(sub, day(2026, 6, 10)).getTime()).toBe(day(2026, 6, 11).getTime());
  });
});

describe("endDate", () => {
  it("does not return a valid day beyond endDate", () => {
    const sub = base({ frequency: "DAILY", endDate: day(2026, 6, 16) });
    // From the last delivery day, the next computed day is past endDate (the DUE query filters it out).
    expect(computeNextDeliveryDate(sub, day(2026, 6, 16)).getTime()).toBeGreaterThan(day(2026, 6, 16).getTime());
  });
});

describe("upcomingDates", () => {
  afterEach(() => vi.useRealTimers());
  it("DAILY returns N consecutive days from nextDeliveryDate", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 15, 6))); // 2026-06-15 11:30 IST
    const sub = { ...base({ frequency: "DAILY" }), nextDeliveryDate: day(2026, 6, 15) };
    const dates = upcomingDates(sub, 3);
    expect(dates.map((d) => d.getTime())).toEqual([
      day(2026, 6, 15).getTime(),
      day(2026, 6, 16).getTime(),
      day(2026, 6, 17).getTime(),
    ]);
  });
});

describe("priceSubscriptionDelivery — FREE delivery (D4)", () => {
  // Minimal variant shape the pricer reads. 18% GST, ₹50 selling, ₹60 MRP, packaged.
  const variant = {
    packageSize: 1,
    packageUnit: "PCS",
    sellingPrice: 50,
    mrp: 60,
    bulkMinQty: 0,
    bulkPrice: null,
    gstRateOverride: null,
    product: { productType: "PACKAGED", gstRate: 18 },
  };
  it("never charges delivery and totalAmount = line total", () => {
    const p = priceSubscriptionDelivery(variant as never, 2);
    expect(p.deliveryCharge).toBe(0);
    expect(p.lineTotal).toBe(100);
    expect(p.totalAmount).toBe(100);
    expect(p.savedAmount).toBe(20); // (60-50)*2
  });
  it("computes GST-inclusive taxable + split", () => {
    const p = priceSubscriptionDelivery(variant as never, 1);
    expect(p.taxableValue).toBeCloseTo(42.37, 2); // 50 / 1.18
    expect(p.cgst + p.sgst).toBeCloseTo(7.63, 2);
  });
});
