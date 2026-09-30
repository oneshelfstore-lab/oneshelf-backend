import { describe, it, expect } from "vitest";
import { customerCancelInfo, shapeSubOrders, orderVertical, CUSTOMER_CANCEL_WINDOW_MS } from "../customerOrderView.js";

const t0 = new Date("2026-09-30T10:00:00Z");
const order = (o: Partial<Parameters<typeof customerCancelInfo>[0]> = {}) => ({
  status: "PLACED", paymentMethod: "COD", paymentStatus: "PENDING", createdAt: t0, ...o,
});

describe("customerCancelInfo", () => {
  it("allows cancel inside the window, inclusive of the boundary", () => {
    expect(customerCancelInfo(order(), t0.getTime() + 60_000).canCancel).toBe(true);
    expect(customerCancelInfo(order(), t0.getTime() + CUSTOMER_CANCEL_WINDOW_MS).canCancel).toBe(true);
  });
  it("refuses one millisecond after the window", () => {
    expect(customerCancelInfo(order(), t0.getTime() + CUSTOMER_CANCEL_WINDOW_MS + 1).canCancel).toBe(false);
  });
  it("refuses once the order is packed even inside the window", () => {
    expect(customerCancelInfo(order({ status: "PACKED" }), t0.getTime() + 1000).canCancel).toBe(false);
  });
  it("an unpaid online order can always be cancelled and has no deadline", () => {
    const r = customerCancelInfo(order({ paymentMethod: "UPI" }), t0.getTime() + 10 * 60_000);
    expect(r).toEqual({ canCancel: true, cancelableUntil: null });
  });
  it("a PAID online order is bound by the window", () => {
    expect(customerCancelInfo(order({ paymentMethod: "UPI", paymentStatus: "PAID" }), t0.getTime() + 10 * 60_000).canCancel).toBe(false);
  });
});

describe("shapeSubOrders", () => {
  const sub = (id: string, status: string, vertical = "SHOP") => ({
    id, status, subtotal: "238.00", packedAt: null, collectedAt: null, _count: { items: 4 },
    seller: { name: id, logoUrl: null, isHouse: false, vertical },
  });
  it("labels A, B, C in the given order and only lets an unaccepted shop be cancelled", () => {
    const r = shapeSubOrders([sub("a", "PLACED"), sub("b", "ACCEPTED"), sub("c", "PLACED")], true);
    expect(r.map((s) => s.label)).toEqual(["A", "B", "C"]);
    expect(r.map((s) => s.canCancel)).toEqual([true, false, true]);
  });
  it("nothing is cancellable once the window has closed", () => {
    expect(shapeSubOrders([sub("a", "PLACED")], false)[0].canCancel).toBe(false);
  });
  it("coerces the Decimal subtotal to a number", () => {
    expect(shapeSubOrders([sub("a", "PLACED")], true)[0].subtotal).toBe(238);
  });
});

describe("orderVertical", () => {
  const s = (v: string) => ({ seller: { vertical: v } });
  it("single, mixed, and legacy-empty", () => {
    expect(orderVertical([s("FOOD")])).toBe("FOOD");
    expect(orderVertical([s("SHOP"), s("FOOD")])).toBe("MIXED");
    expect(orderVertical([])).toBe("SHOP");
  });
});
