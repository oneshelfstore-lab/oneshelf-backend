import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const count = (n: number) => vi.fn(async (_a?: any) => n);
  return {
    partnerApplication: { count: count(2) },
    seller: { count: count(1) },
    deliveryProfile: { count: count(1) },
    cashSettlement: { aggregate: vi.fn(async (_a?: any) => ({ _count: { _all: 3 }, _sum: { amount: "450.50" } })) },
    order: { count: vi.fn(async (a: any) => (a.where.lastDeliveryFailedAt === null ? 4 : 5)) },
    courierBooking: { count: count(1) },
    complaint: { count: count(6) },
    quoteRequest: { count: count(2) },
  };
});
vi.mock("../../lib/prisma.js", () => ({ default: h }));

import { getOwnerAttention } from "../ownerAttention.js";

describe("getOwnerAttention", () => {
  it("counts each bucket and totals them", async () => {
    const a = await getOwnerAttention();
    expect(a.sellers).toEqual({ applications: 2, sellerReview: 1, riderReview: 1 });
    expect(a.payments).toEqual({ cashHandovers: 3, cashAmount: 450.5 });
    expect(a.delivery).toEqual({ unclaimed: 4, failed: 5, courierFailed: 1 });
    expect(a.support).toEqual({ complaints: 6, quotes: 2 });
    expect(a.total).toBe(2 + 1 + 1 + 3 + 4 + 5 + 1 + 6 + 2);
  });

  // One order must never show up as both "no rider yet" and "delivery failed".
  it("keeps unclaimed and failed orders apart, and ignores the house store's onboarding", async () => {
    h.order.count.mockClear();
    h.seller.count.mockClear();
    await getOwnerAttention(Date.UTC(2026, 9, 2, 6, 0));
    const wheres = h.order.count.mock.calls.map((c) => c[0].where);
    expect(wheres.find((w: any) => w.deliveryBoyId === null)).toMatchObject({ lastDeliveryFailedAt: null, status: "PACKED" });
    expect(wheres.find((w: any) => w.lastDeliveryFailedAt?.not === null)).toBeTruthy();
    expect(h.seller.count.mock.calls[0]![0].where).toMatchObject({ isHouse: false });
  });
});
