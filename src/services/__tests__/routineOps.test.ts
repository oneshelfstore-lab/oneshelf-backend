import { describe, it, expect, vi } from "vitest";

// Operations side of routines: the delivery run's slot ordering and the owner/seller planning rows
// (how much to stock, what is short, which window it is for).
const h = vi.hoisted(() => ({ subs: [] as any[] }));
vi.mock("../../lib/prisma.js", () => ({
  default: { subscription: { findMany: vi.fn(async () => h.subs) } },
}));

import { compareRunStops, slotStartHour } from "../../data/deliverySlots.js";
import { computeUpcomingPlan, istMidnight } from "../subscriptionEngine.js";

const at = (iso: string) => new Date(iso);

describe("delivery run order", () => {
  const stop = (slotId: string | null, pincode: string, createdAt = "2026-10-05T01:00:00Z") => ({ slotId, pincode, createdAt: at(createdAt) });

  it("earliest window first", () => {
    const stops = [stop("EVENING", "246701"), stop("MORNING", "246701"), stop("AFTERNOON", "246701")];
    expect(stops.sort(compareRunStops).map((s) => s.slotId)).toEqual(["MORNING", "AFTERNOON", "EVENING"]);
  });

  it("within a window, by area, then oldest first", () => {
    const stops = [
      stop("MORNING", "246702"),
      stop("MORNING", "246701", "2026-10-05T02:00:00Z"),
      stop("MORNING", "246701", "2026-10-05T01:00:00Z"),
    ];
    const out = stops.sort(compareRunStops);
    expect(out.map((s) => s.pincode)).toEqual(["246701", "246701", "246702"]);
    expect(out[0]!.createdAt.toISOString()).toBe("2026-10-05T01:00:00.000Z");
  });

  it("an unknown or missing window sorts last, not first", () => {
    expect(slotStartHour(null)).toBeGreaterThan(slotStartHour("NIGHT"));
    expect([stop(null, "1"), stop("NIGHT", "1")].sort(compareRunStops).map((s) => s.slotId)).toEqual(["NIGHT", null]);
  });
});

describe("computeUpcomingPlan — owner / seller demand", () => {
  const item = (variantId: string, productName: string, quantity: number, over: any = {}) => ({
    variantId, productName, quantity, isLoose: false, stepSize: null, stepUnit: null,
    variant: { stock: 100, product: { sellerId: null } }, ...over,
  });
  const routine = (id: string, deliverySlotId: string, items: any[], over: any = {}) => ({
    id, status: "ACTIVE", frequency: "DAILY", intervalDays: null, daysOfWeek: [], dayOfMonth: null,
    startDate: at("2026-01-01T00:00:00Z"), endDate: null, deliverySlotId, items, variantId: null, quantity: null, ...over,
  });
  const target = istMidnight(at("2026-10-05T06:00:00Z"));

  it("adds every routine's items, per item, across customers", async () => {
    h.subs = [
      routine("r1", "MORNING", [item("milk", "Milk", 2), item("bread", "Bread", 1)]),
      routine("r2", "MORNING", [item("milk", "Milk", 1)]),
    ];
    const rows = await computeUpcomingPlan(target);
    const milk = rows.find((r) => r.variantId === "milk")!;
    expect(milk.totalQty).toBe(3);
    expect(milk.customerCount).toBe(2);
    expect(rows.find((r) => r.variantId === "bread")!.totalQty).toBe(1);
  });

  it("flags a shortfall against live stock and lists the biggest one first", async () => {
    h.subs = [
      routine("r1", "MORNING", [item("milk", "Milk", 10, { variant: { stock: 4, product: { sellerId: null } } }), item("bread", "Bread", 5)]),
    ];
    const rows = await computeUpcomingPlan(target);
    expect(rows[0]).toMatchObject({ variantId: "milk", neededBase: 10, stock: 4, shortBy: 6 });
    expect(rows[1]).toMatchObject({ variantId: "bread", shortBy: 0 });
  });

  it("compares loose items in base units (steps × step size), not raw step counts", async () => {
    // 6 steps of 0.5 kg = 3 kg needed; 2 kg in stock → short by 1 kg (a naive 6-vs-2 would say 4).
    h.subs = [
      routine("r1", "MORNING", [item("tomato", "Tomato", 6, { isLoose: true, stepSize: 0.5, stepUnit: "KG", variant: { stock: 2, product: { sellerId: null } } })]),
    ];
    const [row] = await computeUpcomingPlan(target);
    expect(row).toMatchObject({ totalQty: 6, neededBase: 3, stock: 2, shortBy: 1 });
  });

  it("splits demand by delivery window", async () => {
    h.subs = [
      routine("r1", "MORNING", [item("milk", "Milk", 2)]),
      routine("r2", "EVENING", [item("milk", "Milk", 3)]),
      routine("r3", "MORNING", [item("milk", "Milk", 1)]),
    ];
    const [row] = await computeUpcomingPlan(target);
    expect(row!.bySlot).toEqual({ MORNING: 3, EVENING: 3 });
  });

  it("an old single-product row (no items) still counts", async () => {
    h.subs = [
      routine("old", "MORNING", [], {
        variantId: "milk", productName: "Milk", quantity: 4, isLoose: false, stepSize: null, stepUnit: null,
        variant: { stock: 10, product: { sellerId: null } },
      }),
    ];
    const [row] = await computeUpcomingPlan(target);
    expect(row).toMatchObject({ variantId: "milk", totalQty: 4, neededBase: 4, shortBy: 0 });
  });

  it("a seller only sees their own items of a routine", async () => {
    h.subs = [
      routine("r1", "MORNING", [
        item("milk", "Milk", 2, { variant: { stock: 9, product: { sellerId: "sellerA" } } }),
        item("bread", "Bread", 1, { variant: { stock: 9, product: { sellerId: "sellerB" } } }),
      ]),
    ];
    const rows = await computeUpcomingPlan(target, "sellerA", false);
    expect(rows.map((r) => r.variantId)).toEqual(["milk"]);
  });

  it("the house seller also owns products with no seller set", async () => {
    h.subs = [
      routine("r1", "MORNING", [
        item("milk", "Milk", 2, { variant: { stock: 9, product: { sellerId: null } } }),
        item("rice", "Rice", 1, { variant: { stock: 9, product: { sellerId: "house" } } }),
        item("soap", "Soap", 1, { variant: { stock: 9, product: { sellerId: "other" } } }),
      ]),
    ];
    const rows = await computeUpcomingPlan(target, "house", true);
    expect(rows.map((r) => r.variantId).sort()).toEqual(["milk", "rice"]);
  });
});
