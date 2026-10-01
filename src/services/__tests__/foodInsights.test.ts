import { describe, it, expect } from "vitest";
import { kitchenStats } from "../foodInsights.js";

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 1, h, m)); // UTC; IST = +5:30

describe("kitchenStats", () => {
  it("counts orders, accepted and cancelled, and the cancellation rate", () => {
    const s = kitchenStats(
      [
        { id: "a", status: "COLLECTED", createdAt: at(10) },
        { id: "b", status: "ACCEPTED", createdAt: at(10) },
        { id: "c", status: "CANCELLED", createdAt: at(10) },
        { id: "d", status: "PLACED", createdAt: at(10) },
      ],
      [],
    );
    expect(s.orders).toBe(4);
    expect(s.accepted).toBe(2);
    expect(s.cancelled).toBe(1);
    expect(s.cancellationRatePct).toBe(25);
  });

  it("has no rate with no orders, rather than 0% or NaN", () => {
    const s = kitchenStats([], []);
    expect(s.cancellationRatePct).toBeNull();
    expect(s.avgPrepMinutes).toBeNull();
    expect(s.peakBlocks).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("buckets by IST 3-hour block, not UTC", () => {
    // 14:30 UTC = 20:00 IST -> block 6 (18-21). 18:30 UTC = 00:00 IST next day -> block 0.
    const s = kitchenStats(
      [
        { id: "a", status: "PACKED", createdAt: at(14, 30) },
        { id: "b", status: "PACKED", createdAt: at(18, 30) },
      ],
      [],
    );
    expect(s.peakBlocks[6]).toBe(1);
    expect(s.peakBlocks[0]).toBe(1);
  });

  it("averages accept->ready, using the FIRST of each event and ignoring implausible gaps", () => {
    const s = kitchenStats(
      [
        { id: "a", status: "PACKED", createdAt: at(10) },
        { id: "b", status: "PACKED", createdAt: at(10) },
        { id: "c", status: "PACKED", createdAt: at(10) },
      ],
      [
        { subOrderId: "a", toState: "ACCEPTED", createdAt: at(10, 0) },
        { subOrderId: "a", toState: "PACKED", createdAt: at(10, 20) },
        { subOrderId: "a", toState: "PACKED", createdAt: at(11, 0) }, // a later re-tap must not count
        { subOrderId: "b", toState: "ACCEPTED", createdAt: at(10, 0) },
        { subOrderId: "b", toState: "PACKED", createdAt: at(10, 40) },
        { subOrderId: "c", toState: "ACCEPTED", createdAt: at(10, 0) },
        { subOrderId: "c", toState: "PACKED", createdAt: at(20, 0) }, // forgotten overnight, ignored
      ],
    );
    expect(s.avgPrepMinutes).toBe(30); // (20 + 40) / 2
  });
});
