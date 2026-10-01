import { describe, it, expect } from "vitest";
import { planRoutineRun, type LiveVariant, type RoutineItemRow } from "../routinePlan.js";

// Pure planner: what would a run deliver, what would it cost, is it within the price ceiling.

function variant(id: string, price: number, stock: number, over: Partial<LiveVariant> & { productType?: string; packageSize?: number } = {}): LiveVariant {
  const { productType = "PACKAGED", packageSize = 1, ...rest } = over;
  return {
    isActive: true,
    stock,
    packageSize,
    packageUnit: "PCS",
    sellingPrice: price,
    mrp: price + 5,
    bulkMinQty: 0,
    bulkPrice: null,
    gstRateOverride: null,
    product: { productType, gstRate: 0 },
    ...rest,
  } as LiveVariant;
}

function item(variantId: string, quantity: number, unitPriceSnapshot: number | null): RoutineItemRow {
  return { id: `i-${variantId}`, variantId, productName: variantId, imageUrl: null, quantity, unitPriceSnapshot };
}

const ABS30 = { type: "ABSOLUTE", value: 30 } as const;

describe("planRoutineRun — multi-item basket", () => {
  it("sums every line into one total / subtotal / saved amount", () => {
    const plan = planRoutineRun(
      [item("milk", 2, 50), item("bread", 1, 40)],
      new Map([["milk", variant("milk", 50, 10)], ["bread", variant("bread", 40, 10)]]),
      ABS30,
    );
    expect(plan.lines).toHaveLength(2);
    expect(plan.totalAmount).toBe(140); // 2×50 + 1×40
    expect(plan.subtotal).toBe(140);
    expect(plan.savedAmount).toBe(15); // (55-50)×2 + (45-40)×1
    expect(plan.skipped).toHaveLength(0);
  });

  it("splits GST per line and sums it", () => {
    const plan = planRoutineRun(
      [item("a", 1, 118)],
      new Map([["a", variant("a", 118, 5, { product: { productType: "PACKAGED", gstRate: 18 } })]]),
      ABS30,
    );
    expect(plan.taxableValue).toBe(100);
    expect(plan.totalTax).toBe(18);
  });

  it("loose items demand quantity × packageSize base units", () => {
    const plan = planRoutineRun(
      [item("tom", 3, null)],
      new Map([["tom", variant("tom", 40, 10, { productType: "PRODUCE", packageSize: 0.5 })]]),
      ABS30,
    );
    expect(plan.lines[0]!.needed).toBeCloseTo(1.5);
  });
});

describe("planRoutineRun — partial out-of-stock", () => {
  it("skips an out-of-stock line and keeps the rest", () => {
    const plan = planRoutineRun(
      [item("milk", 2, 50), item("eggs", 1, 70)],
      new Map([["milk", variant("milk", 50, 10)], ["eggs", variant("eggs", 70, 0)]]),
      ABS30,
    );
    expect(plan.lines.map((l) => l.item.variantId)).toEqual(["milk"]);
    expect(plan.skipped).toEqual([expect.objectContaining({ reason: "OOS" })]);
    expect(plan.totalAmount).toBe(100);
  });

  it("treats a missing or inactive variant as unavailable", () => {
    const plan = planRoutineRun(
      [item("gone", 1, 10), item("off", 1, 10), item("ok", 1, 10)],
      new Map([["off", variant("off", 10, 9, { isActive: false })], ["ok", variant("ok", 10, 9)]]),
      ABS30,
    );
    expect(plan.lines).toHaveLength(1);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["UNAVAILABLE", "UNAVAILABLE"]);
  });

  it("dropping an out-of-stock line is NOT price drift (estimate covers delivered lines only)", () => {
    const plan = planRoutineRun(
      [item("milk", 2, 50), item("eggs", 1, 70)],
      new Map([["milk", variant("milk", 50, 10)], ["eggs", variant("eggs", 70, 0)]]),
      { type: "ABSOLUTE", value: 0 },
    );
    expect(plan.estimate).toBe(100);
    expect(plan.drift).toBe(0);
    expect(plan.withinCeiling).toBe(true);
  });
});

describe("planRoutineRun — price ceiling", () => {
  const stock = (price: number) => new Map([["milk", variant("milk", price, 10)], ["bread", variant("bread", 40, 10)]]);
  const items = [item("milk", 2, 50), item("bread", 1, 40)]; // estimate 140

  it("within the ceiling: +₹20 ≤ ₹30 → auto-order", () => {
    const plan = planRoutineRun(items, stock(60), ABS30); // milk 2×60 = 120 → total 160
    expect(plan.estimate).toBe(140);
    expect(plan.drift).toBe(20);
    expect(plan.withinCeiling).toBe(true);
  });

  it("exactly at the ceiling is allowed", () => {
    const plan = planRoutineRun(items, stock(65), ABS30); // total 170 → +30
    expect(plan.drift).toBe(30);
    expect(plan.withinCeiling).toBe(true);
  });

  it("above the ceiling: +₹40 > ₹30 → hold", () => {
    const plan = planRoutineRun(items, stock(70), ABS30); // total 180 → +40
    expect(plan.drift).toBe(40);
    expect(plan.withinCeiling).toBe(false);
  });

  it("a price DROP is always fine, even with a zero ceiling", () => {
    const plan = planRoutineRun(items, stock(40), { type: "ABSOLUTE", value: 0 });
    expect(plan.drift).toBe(-20);
    expect(plan.withinCeiling).toBe(true);
  });

  it("PERCENT ceilings are enforced too (modelled now, exposed later)", () => {
    // estimate 140, 10% → +₹14 allowed
    expect(planRoutineRun(items, stock(56), { type: "PERCENT", value: 10 }).withinCeiling).toBe(true); // +12
    const over = planRoutineRun(items, stock(58), { type: "PERCENT", value: 10 }); // +16
    expect(over.allowedIncrease).toBe(14);
    expect(over.withinCeiling).toBe(false);
  });

  it("a line with no baseline snapshot compares against its own current price (never held)", () => {
    const plan = planRoutineRun([item("milk", 2, null)], new Map([["milk", variant("milk", 999, 10)]]), { type: "ABSOLUTE", value: 0 });
    expect(plan.estimate).toBe(plan.totalAmount);
    expect(plan.withinCeiling).toBe(true);
  });
});
