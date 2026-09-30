import { describe, it, expect } from "vitest";
import { assessBooking, type FlagEvent } from "../courierFlags.js";

const T0 = 1_700_000_000_000;
const ev = (type: string, secs: number, lat: number | null = null, lng: number | null = null): FlagEvent => ({
  type, at: new Date(T0 + secs * 1000), lat, lng,
});
// 0.009° lat ≈ 1 km
const km = (n: number) => 29.37 + n * 0.009;

describe("assessBooking", () => {
  it("a normal trip raises nothing", () => {
    const events = [
      ev("BOOKED", 0, km(0), 78.13),
      ev("RIDER_ASSIGNED", 120, km(2), 78.13),
      ev("PICKED_UP", 600, km(0), 78.13),
      ev("DELIVERED", 1500, km(6), 78.13), // 6 km in 15 min = 24 km/h
    ];
    expect(assessBooking(events, 6)).toEqual([]);
  });

  it("flags repeated refusals at one handoff, not scattered single ones", () => {
    const three = [ev("PICKUP_REFUSED", 1), ev("PICKUP_REFUSED", 5), ev("PICKUP_REFUSED", 9)];
    expect(assessBooking(three, 5)).toContain("MANY_REFUSALS");
    const mixed = [ev("PICKUP_REFUSED", 1), ev("PICKUP_REFUSED", 5), ev("DELIVERY_REFUSED", 9)];
    expect(assessBooking(mixed, 5)).not.toContain("MANY_REFUSALS");
  });

  it("flags a position jump no scooter could make", () => {
    // 5 km in 60 s = 300 km/h
    const events = [ev("RIDER_ASSIGNED", 0, km(0), 78.13), ev("PICKED_UP", 60, km(5), 78.13)];
    expect(assessBooking(events, 5)).toContain("IMPOSSIBLE_TRAVEL");
  });

  it("ignores GPS jitter: small distance or tiny time gap is noise", () => {
    expect(assessBooking([ev("A", 0, km(0), 78.13), ev("B", 60, km(0.4), 78.13)], 5)).toEqual([]); // 0.4 km < 1 km
    expect(assessBooking([ev("A", 0, km(0), 78.13), ev("B", 5, km(3), 78.13)], 5)).toEqual([]); // 5 s gap
  });

  it("only compares events that actually carry a position", () => {
    const events = [ev("A", 0, km(0), 78.13), ev("SYSTEM_NOTE", 30), ev("B", 3600, km(5), 78.13)];
    expect(assessBooking(events, 5)).toEqual([]);
  });

  it("flags an instant pickup-to-delivery over a real distance, not a short hop", () => {
    const fast = [ev("PICKED_UP", 0), ev("DELIVERED", 90)];
    expect(assessBooking(fast, 6)).toContain("INSTANT_DELIVERY");
    expect(assessBooking(fast, 1)).not.toContain("INSTANT_DELIVERY");
  });
});
