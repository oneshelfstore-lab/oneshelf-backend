import { describe, it, expect } from "vitest";
import { buildCourierReport, type ReportRow } from "../courierReport.js";

const T = 1_700_000_000_000;
const at = (min: number) => new Date(T + min * 60_000);
const row = (o: Partial<ReportRow>): ReportRow => ({
  status: "DELIVERED", total: 52, deliveryFee: 49, platformFee: 3, createdAt: at(0), acceptedAt: at(5), deliveredAt: at(35),
  riderId: "r1", ratingStars: null, ...o,
});
const names = new Map([["r1", "Aman"], ["r2", "Bilal"]]);

describe("buildCourierReport", () => {
  it("counts revenue only from DELIVERED bookings", () => {
    const rep = buildCourierReport([row({}), row({ total: 69, deliveryFee: 66 }), row({ status: "CANCELLED", riderId: null, deliveredAt: null })], names);
    expect(rep.revenue).toBe(121);
    expect(rep.deliveryFees).toBe(115);
    expect(rep.platformFees).toBe(6);
    expect(rep.delivered).toBe(2);
    expect(rep.cancelled).toBe(1);
    expect(rep.bookings).toBe(3);
  });

  it("failure rate is failed / (delivered + failed): a cancel before pickup is not a failed attempt", () => {
    const rows = [row({}), row({}), row({}), row({ status: "FAILED", deliveredAt: null }), row({ status: "CANCELLED", riderId: null, deliveredAt: null })];
    expect(buildCourierReport(rows, names).failureRatePct).toBe(25);
    expect(buildCourierReport([row({ status: "CANCELLED", riderId: null, deliveredAt: null })], names).failureRatePct).toBeNull();
  });

  it("times: overall is placed→delivered, per-rider is accepted→delivered", () => {
    const rep = buildCourierReport([row({})], names);
    expect(rep.avgDeliveryMinutes).toBe(35);
    expect(rep.riders[0].avgMinutes).toBe(30);
  });

  it("averages ratings only over rated bookings, null when none", () => {
    expect(buildCourierReport([row({})], names).avgRating).toBeNull();
    const rep = buildCourierReport([row({ ratingStars: 5 }), row({ ratingStars: 4 }), row({})], names);
    expect(rep.avgRating).toBe(4.5);
    expect(rep.ratingCount).toBe(2);
  });

  it("groups by rider, busiest first, and falls back when a name is unknown", () => {
    const rep = buildCourierReport([row({ riderId: "r2" }), row({ riderId: "r1" }), row({ riderId: "r1" }), row({ riderId: "ghost" })], names);
    expect(rep.riders.map((r) => [r.name, r.delivered])).toEqual([["Aman", 2], ["Bilal", 1], ["Delivery partner", 1]]);
  });

  it("an empty window is all zeros and nulls, not NaN", () => {
    const rep = buildCourierReport([], names);
    expect(rep).toMatchObject({ bookings: 0, revenue: 0, failureRatePct: null, avgDeliveryMinutes: null, avgRating: null, riders: [] });
  });
});
