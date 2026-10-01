import { describe, it, expect } from "vitest";
import { detectRecurring, pickSubstitute, shouldAlertPriceChange, type Purchase } from "../routineIntel.js";
import type { LiveVariant } from "../routinePlan.js";

// Pure intelligence: spotting a habit, choosing a stand-in, deciding when a price push is worth sending.

const NOW = new Date("2026-10-20T06:00:00Z");
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 6)); // 2026-10-n, 11:30 IST
const buy = (variantId: string, d: number, quantity = 1, storeKey = "house"): Purchase => ({ variantId, storeKey, quantity, at: day(d) });

describe("detectRecurring", () => {
  it("a daily habit: bought most days → DAILY, with the usual quantity", () => {
    const s = detectRecurring([14, 15, 16, 17, 18, 19].map((d) => buy("milk", d, 2)), NOW)!;
    expect(s.cadence).toBe("DAILY");
    expect(s.items).toEqual([expect.objectContaining({ variantId: "milk", quantity: 2, timesBought: 6, everyDays: 1 })]);
  });

  it("a weekly habit: same weekday each week → WEEKLY on that weekday", () => {
    // 2026-10-04 and the three Sundays after it (4, 11, 18)… plus 27 Sep
    const s = detectRecurring([sunday(27, 9), sunday(4), sunday(11), sunday(18)].map((at) => ({ variantId: "fruit", storeKey: "house", quantity: 1, at })), NOW)!;
    expect(s.cadence).toBe("WEEKLY");
    expect(s.daysOfWeek).toEqual([0]);
  });

  it("quantity prediction is the median of what they usually buy, ignoring one-off spikes", () => {
    const s = detectRecurring([buy("milk", 14, 2), buy("milk", 15, 2), buy("milk", 16, 9), buy("milk", 17, 2), buy("milk", 18, 2)], NOW)!;
    expect(s.items[0]!.quantity).toBe(2);
  });

  it("needs at least three distinct days", () => {
    expect(detectRecurring([buy("milk", 17), buy("milk", 18)], NOW)).toBeNull();
  });

  it("several orders on one day are one event, not a habit", () => {
    expect(detectRecurring([buy("milk", 18), buy("milk", 18), buy("milk", 18)], NOW)).toBeNull();
  });

  it("not a daily-need rhythm when the gaps are long", () => {
    const monthly: Purchase[] = [{ variantId: "atta", storeKey: "house", quantity: 1, at: new Date("2026-07-01T06:00:00Z") }, { variantId: "atta", storeKey: "house", quantity: 1, at: new Date("2026-08-01T06:00:00Z") }, { variantId: "atta", storeKey: "house", quantity: 1, at: new Date("2026-09-01T06:00:00Z") }];
    expect(detectRecurring(monthly, NOW)).toBeNull();
  });

  it("a habit that has stopped is not suggested", () => {
    expect(detectRecurring([1, 2, 3, 4, 5].map((d) => buy("milk", d)), NOW)).toBeNull(); // last bought 15 days ago
  });

  it("one routine is one store: the store with the most habits wins", () => {
    const rows = [
      ...[14, 16, 18].map((d) => buy("milk", d, 1, "A")),
      ...[14, 16, 18].map((d) => buy("bread", d, 1, "A")),
      ...[14, 16, 18].map((d) => buy("soap", d, 1, "B")),
    ];
    const s = detectRecurring(rows, NOW)!;
    expect(s.storeKey).toBe("A");
    expect(s.items.map((i) => i.variantId).sort()).toEqual(["bread", "milk"]);
  });

  it("one routine is one schedule: only the dominant cadence's items are returned", () => {
    const rows = [
      ...[14, 15, 16, 17, 18].map((d) => buy("milk", d)),
      ...[14, 15, 16, 17, 18].map((d) => buy("bread", d)),
      ...[sunday(27, 9), sunday(4), sunday(11), sunday(18)].map((at) => ({ variantId: "fruit", storeKey: "house", quantity: 1, at })),
    ];
    const s = detectRecurring(rows, NOW)!;
    expect(s.cadence).toBe("DAILY");
    expect(s.items.map((i) => i.variantId).sort()).toEqual(["bread", "milk"]);
  });
});

function sunday(date: number, month = 10): Date {
  return new Date(Date.UTC(2026, month - 1, date, 6));
}

describe("pickSubstitute", () => {
  const v = (id: string, price: number, stock: number, over: Partial<LiveVariant> & { productType?: string } = {}): LiveVariant & { id: string } => {
    const { productType = "PACKAGED", ...rest } = over;
    return { id, isActive: true, stock, packageSize: 1, packageUnit: "PCS", sellingPrice: price, mrp: price + 5, bulkMinQty: 0, bulkPrice: null, gstRateOverride: null, product: { productType, gstRate: 0 }, ...rest } as LiveVariant & { id: string };
  };
  const original = v("amul", 60, 0);

  it("picks the closest-priced in-stock candidate", () => {
    expect(pickSubstitute(original, 1, [v("a", 70, 5), v("b", 62, 5), v("c", 50, 5)])!.id).toBe("b");
  });

  it("on an equal price gap the cheaper one wins", () => {
    expect(pickSubstitute(original, 1, [v("dear", 66, 5), v("cheap", 54, 5)])!.id).toBe("cheap");
  });

  it("skips what is out of stock, inactive, or too far in price (±30%)", () => {
    const out = pickSubstitute(original, 2, [v("lowstock", 60, 1), v("off", 60, 9, { isActive: false }), v("far", 100, 9), v("tiny", 30, 9)]);
    expect(out).toBeNull();
  });

  it("only the same kind of product (never a packaged item for a loose one)", () => {
    expect(pickSubstitute(v("tomato", 40, 0, { productType: "PRODUCE" }), 1, [v("packed", 40, 9, { productType: "PACKAGED" })])).toBeNull();
  });

  it("loose stock is compared in base units for the quantity needed", () => {
    const loose = (id: string, stock: number) => v(id, 40, stock, { productType: "PRODUCE", packageSize: 0.5 });
    // 4 steps of 0.5 kg = 2 kg needed
    expect(pickSubstitute(loose("orig", 0), 4, [loose("short", 1.5)])).toBeNull();
    expect(pickSubstitute(loose("orig", 0), 4, [loose("enough", 2)])!.id).toBe("enough");
  });
});

describe("shouldAlertPriceChange", () => {
  it("a rise of ₹10+ over the usual alerts the first time", () => {
    expect(shouldAlertPriceChange(12, 152, null)).toBe("alert");
  });
  it("a small rise stays quiet", () => {
    expect(shouldAlertPriceChange(6, 146, null)).toBe("none");
  });
  it("the same elevated price is not re-announced every morning", () => {
    expect(shouldAlertPriceChange(12, 152, 152)).toBe("none");
    expect(shouldAlertPriceChange(12, 154, 152)).toBe("none"); // moved only ₹2
  });
  it("a further move of ₹5+ alerts again", () => {
    expect(shouldAlertPriceChange(18, 158, 152)).toBe("alert");
  });
  it("back to normal resets, so the next rise alerts again", () => {
    expect(shouldAlertPriceChange(0, 140, 152)).toBe("reset");
    expect(shouldAlertPriceChange(-5, 135, null)).toBe("none");
  });
});
