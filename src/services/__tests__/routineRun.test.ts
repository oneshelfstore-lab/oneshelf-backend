import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Routine order generation (generateRoutineOrder) against a fake Prisma.
 *
 * One routine + one store + one run must produce ONE Order with one OrderItem per available line. The
 * fake records what the engine wrote, so these pin: multi-item generation, per-line stock deduction,
 * partial out-of-stock, price drift within / above the ceiling, idempotency, and that an old
 * single-product subscription (no SubscriptionItem rows) still delivers.
 *
 * Fakes rather than a real DB (no Postgres in CI here; same approach as cancelOrder.test.ts).
 */
const h = vi.hoisted(() => {
  const state = {
    exception: null as null | { id: string; type: string },
    variants: [] as any[],
    candidates: [] as any[], // what the substitute lookup finds
    stock: {} as Record<string, number>, // base-unit stock per variant, mutated by the fake consumeFifo
    duplicateOrder: false,
    walletOk: true,
  };
  const tx: any = {
    order: {
      create: vi.fn(async (a: any) => {
        if (state.duplicateOrder) throw Object.assign(new Error("unique"), { code: "P2002" });
        return {
          id: "order1",
          orderNumber: "N1",
          totalAmount: a.data.totalAmount,
          customerId: a.data.customerId,
          items: a.data.items.create.map((it: any, i: number) => ({ id: `oi${i}`, variantId: it.variantId })),
        };
      }),
    },
    orderItem: { update: vi.fn(async () => ({})) },
    user: {
      updateMany: vi.fn(async () => ({ count: state.walletOk ? 1 : 0 })),
      findUnique: vi.fn(async () => ({ walletBalance: 100 })),
    },
    walletTransaction: { create: vi.fn(async () => ({})) },
    seller: {
      findUnique: vi.fn(async () => ({ id: "house", commissionPct: 0, isHouse: true, pan: null, entityType: null })),
      update: vi.fn(async () => ({})),
    },
    subOrder: { create: vi.fn(async () => ({ id: "so1" })) },
    // No owner-set category rates in these fixtures → every line falls through to the seller rate.
    sellerCategoryCommission: { findMany: vi.fn(async () => []) },
  };
  const prisma: any = {
    subscriptionException: {
      findUnique: vi.fn(async () => state.exception),
      upsert: vi.fn(async () => {
        state.exception = { id: "ex1", type: "HELD" };
        return state.exception;
      }),
    },
    // The routine's own variants are fetched by id; the substitute lookup has no `id.in`.
    productVariant: { findMany: vi.fn(async (a: any) => (a?.where?.id?.in ? state.variants : state.candidates)) },
    subscription: { update: vi.fn(async () => ({})) },
    address: { findUnique: vi.fn(async () => ({ id: "a1", addressLine: "1 Main St", pincode: "246701" })) },
    user: { findUnique: vi.fn(async () => ({ name: "Cust", phone: "9999999999" })) },
    seller: { findFirst: vi.fn(async () => ({ id: "house" })) },
    subscriptionItem: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  const consumeFifo = vi.fn();
  const recordConsumption = vi.fn(async () => {});
  const notify = {
    notifyNewOrder: vi.fn(async () => {}),
    notifyRoutineHeld: vi.fn(async () => {}),
    notifyRoutineItemsSkipped: vi.fn(async () => {}),
    notifyRoutineSubstituted: vi.fn(async () => {}),
    notifyRoutinePriceUp: vi.fn(async () => {}),
    notifySubscriptionSkipped: vi.fn(async () => {}),
    notifySubscriptionLowBalance: vi.fn(async () => {}),
    notifySubscriptionStatement: vi.fn(async () => {}),
    notifySubscriptionEndingSoon: vi.fn(async () => {}),
  };
  const generateOrderInvoice = vi.fn(async () => {});
  return { state, tx, prisma, consumeFifo, recordConsumption, notify, generateOrderInvoice };
});

vi.mock("../../lib/prisma.js", () => ({ default: h.prisma }));
vi.mock("../stockBatches.js", () => ({ consumeFifo: h.consumeFifo, recordConsumption: h.recordConsumption }));
vi.mock("../fcmNotifier.js", () => h.notify);
vi.mock("../orderInvoice.js", () => ({
  generateOrderInvoice: h.generateOrderInvoice,
  generateStatementInvoice: vi.fn(),
  markStatementInvoicePaid: vi.fn(),
}));
vi.mock("../orderNumbering.js", () => ({ getNextOrderNumber: vi.fn(async () => "N1") }));
vi.mock("../razorpay.js", () => ({ chargeSubscriptionMandate: vi.fn(async () => null) }));
vi.mock("../sellerTds194o.js", () => ({ computeSubOrderTds194o: vi.fn(async () => ({ tdsAmount: 0 })) }));
vi.mock("../entitySplit.js", () => ({
  houseSellerIsSeparateEntity: vi.fn(async () => false),
  isSameLegalEntity: (seller: { isHouse: boolean }) => seller.isHouse,
}));

import { AppError } from "../../lib/errors.js";
import { generateRoutineOrder, istMidnight, type RoutineRow } from "../subscriptionEngine.js";

const DAY = istMidnight(new Date());

function variant(id: string, price: number, stock: number, over: { productType?: string; packageSize?: number } = {}) {
  h.state.stock[id] = stock * (over.packageSize ?? 1) ; // base units
  return {
    id,
    sku: `sku-${id}`,
    isActive: true,
    stock: h.state.stock[id],
    packageSize: over.packageSize ?? 1,
    packageUnit: "PCS",
    sellingPrice: price,
    mrp: price + 5,
    bulkMinQty: 0,
    bulkPrice: null,
    gstRateOverride: null,
    product: {
      id: `p-${id}`,
      name: id[0]!.toUpperCase() + id.slice(1),
      productType: over.productType ?? "PACKAGED",
      hsnCode: "0401",
      gstRate: 0,
      isPackaged: true,
      categoryId: "cat1",
      imageUrls: [],
      sellerId: null,
      commissionPctOverride: null,
    },
  };
}

function lineItem(variantId: string, quantity: number, unitPriceSnapshot: number | null, substitution?: "SKIP" | "SIMILAR") {
  return { id: `i-${variantId}`, variantId, productName: variantId, imageUrl: null, quantity, unitPriceSnapshot, ...(substitution ? { substitution } : {}) };
}

function routine(over: Partial<RoutineRow> = {}): RoutineRow {
  return {
    id: "sub1",
    customerId: "u1",
    name: "Morning essentials",
    productName: "Morning essentials",
    imageUrl: null,
    addressId: "a1",
    billing: "COD",
    mandateId: null,
    priceCeilingType: "ABSOLUTE",
    priceCeilingValue: 30,
    items: [lineItem("milk", 2, 50), lineItem("bread", 1, 40)],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.exception = null;
  h.state.duplicateOrder = false;
  h.state.walletOk = true;
  h.state.stock = {};
  h.state.variants = [variant("milk", 50, 20), variant("bread", 40, 20)];
  h.state.candidates = [];
  h.consumeFifo.mockImplementation(async (_tx: unknown, variantId: string, qty: number) => {
    if ((h.state.stock[variantId] ?? 0) + 1e-9 < qty) throw new AppError(400, "INSUFFICIENT_STOCK", "Insufficient stock");
    h.state.stock[variantId]! -= qty;
    return { consumed: [{ batchId: `b-${variantId}`, qty, unitCost: 10 }], totalQty: qty, weightedUnitCost: 10 };
  });
});

const orderData = () => h.tx.order.create.mock.calls[0]![0].data;

describe("multi-item generation", () => {
  it("one routine + one store + one run → ONE Order with one OrderItem per line", async () => {
    const result = await generateRoutineOrder(routine(), DAY, null);
    expect(result).toBe("generated");
    expect(h.tx.order.create).toHaveBeenCalledTimes(1);
    const d = orderData();
    expect(d.items.create.map((i: any) => i.variantId)).toEqual(["milk", "bread"]);
    expect(d.subtotal).toBe(140);
    expect(d.totalAmount).toBe(140);
    expect(d.deliveryCharge).toBe(0);
    expect(d.status).toBe("PACKED");
    expect(d.subscriptionId).toBe("sub1");
    expect(d.subscriptionDate).toEqual(DAY);
    // one seller → one SubOrder, and every line is linked to it
    expect(h.tx.subOrder.create).toHaveBeenCalledTimes(1);
    expect(h.tx.orderItem.update).toHaveBeenCalledTimes(2);
    expect(h.generateOrderInvoice).toHaveBeenCalledWith("order1");
    expect(h.notify.notifyNewOrder).toHaveBeenCalledTimes(1);
  });

  it("wallet: ONE debit for the whole basket", async () => {
    await generateRoutineOrder(routine({ billing: "WALLET" }), DAY, null);
    expect(h.tx.user.updateMany).toHaveBeenCalledTimes(1);
    expect(h.tx.user.updateMany.mock.calls[0]![0].data).toEqual({ walletBalance: { decrement: 140 } });
    expect(h.tx.walletTransaction.create).toHaveBeenCalledTimes(1);
    expect(orderData().walletApplied).toBe(140);
    expect(orderData().paymentStatus).toBe("PAID");
  });

  it("wallet short → whole run skipped + customer told, nothing delivered", async () => {
    h.state.walletOk = false;
    const result = await generateRoutineOrder(routine({ billing: "WALLET" }), DAY, null);
    expect(result).toBe("skipped_lowbalance");
    expect(h.notify.notifySubscriptionLowBalance).toHaveBeenCalledTimes(1);
    expect(h.notify.notifyNewOrder).not.toHaveBeenCalled();
  });

  it("a calendar-skipped date generates nothing", async () => {
    h.state.exception = { id: "ex", type: "SKIP" };
    expect(await generateRoutineOrder(routine(), DAY, null)).toBe("skipped_date");
    expect(h.tx.order.create).not.toHaveBeenCalled();
  });
});

describe("stock deduction", () => {
  it("draws every line's base units and links each draw to its own OrderItem", async () => {
    h.state.variants = [variant("milk", 50, 20), variant("tomato", 40, 10, { productType: "PRODUCE", packageSize: 0.5 })];
    await generateRoutineOrder(
      routine({ items: [lineItem("milk", 2, 50), lineItem("tomato", 3, null)] }),
      DAY,
      null,
    );
    // milk: 2 units; tomato (loose): 3 steps × 0.5 = 1.5 base units
    expect(h.consumeFifo.mock.calls.map((c) => [c[1], c[2]])).toEqual([["milk", 2], ["tomato", 1.5]]);
    expect(h.state.stock.milk).toBe(18);
    expect(h.state.stock.tomato).toBe(5 - 1.5);
    expect(h.recordConsumption).toHaveBeenCalledTimes(2);
    expect((h.recordConsumption.mock.calls as unknown as [unknown, { orderItemId: string }][]).map((c) => c[1].orderItemId)).toEqual(["oi0", "oi1"]);
  });

  it("a stock race lost inside the txn rolls the whole run back (no half-shipped basket)", async () => {
    // plan sees stock (20) but the draw finds none left
    h.consumeFifo.mockImplementationOnce(async () => {
      throw new AppError(400, "INSUFFICIENT_STOCK", "Insufficient stock");
    });
    const result = await generateRoutineOrder(routine(), DAY, null);
    expect(result).toBe("skipped_oos");
    expect(h.tx.order.create).not.toHaveBeenCalled();
    expect(h.notify.notifySubscriptionSkipped).toHaveBeenCalledTimes(1);
  });
});

describe("partial out-of-stock", () => {
  it("skips the unavailable item, ships the rest, charges only what ships, and notifies", async () => {
    h.state.variants = [variant("milk", 50, 20), variant("bread", 40, 0)];
    const result = await generateRoutineOrder(routine({ billing: "WALLET" }), DAY, null);
    expect(result).toBe("generated");
    expect(orderData().items.create.map((i: any) => i.variantId)).toEqual(["milk"]);
    expect(orderData().totalAmount).toBe(100);
    expect(h.tx.user.updateMany.mock.calls[0]![0].data).toEqual({ walletBalance: { decrement: 100 } });
    expect(h.notify.notifyRoutineItemsSkipped).toHaveBeenCalledWith("u1", "Morning essentials", ["bread"]);
    expect(h.notify.notifyRoutineHeld).not.toHaveBeenCalled(); // losing a line is not a price change
  });

  it("everything unavailable → no order, customer told", async () => {
    h.state.variants = [variant("milk", 50, 0), variant("bread", 40, 0)];
    expect(await generateRoutineOrder(routine(), DAY, null)).toBe("skipped_oos");
    expect(h.tx.order.create).not.toHaveBeenCalled();
    expect(h.notify.notifySubscriptionSkipped).toHaveBeenCalledWith("u1", "Morning essentials");
  });
});

describe("price ceiling", () => {
  it("drift within the ceiling → ordered automatically at the refreshed price; baseline untouched", async () => {
    h.state.variants = [variant("milk", 60, 20), variant("bread", 40, 20)]; // +₹20 on estimate 140
    expect(await generateRoutineOrder(routine(), DAY, null)).toBe("generated");
    expect(orderData().totalAmount).toBe(160);
    expect(h.notify.notifyRoutineHeld).not.toHaveBeenCalled();
    expect(h.prisma.subscriptionItem.update).not.toHaveBeenCalled(); // snapshots exist, run was automatic
  });

  it("drift above the ceiling → HELD: nothing ordered, nothing charged, nothing consumed, customer notified", async () => {
    h.state.variants = [variant("milk", 70, 20), variant("bread", 40, 20)]; // +₹40 > ₹30
    const result = await generateRoutineOrder(routine({ billing: "WALLET" }), DAY, null);
    expect(result).toBe("held");
    expect(h.tx.order.create).not.toHaveBeenCalled();
    expect(h.tx.user.updateMany).not.toHaveBeenCalled();
    expect(h.consumeFifo).not.toHaveBeenCalled();
    expect(h.prisma.subscriptionException.upsert).toHaveBeenCalledTimes(1);
    expect(h.notify.notifyRoutineHeld).toHaveBeenCalledWith("u1", "Morning essentials", "sub1", 180, 140);
  });

  it("an already-held day is not re-notified on a second sweep", async () => {
    h.state.variants = [variant("milk", 70, 20), variant("bread", 40, 20)];
    await generateRoutineOrder(routine(), DAY, null);
    await generateRoutineOrder(routine(), DAY, null);
    expect(h.notify.notifyRoutineHeld).toHaveBeenCalledTimes(1);
    expect(h.tx.order.create).not.toHaveBeenCalled();
  });

  it("customer approval places the held run at today's price and re-baselines the snapshots", async () => {
    h.state.variants = [variant("milk", 70, 20), variant("bread", 40, 20)];
    await generateRoutineOrder(routine(), DAY, null); // held
    const result = await generateRoutineOrder(routine(), DAY, null, { ignoreCeiling: true });
    expect(result).toBe("generated");
    expect(orderData().totalAmount).toBe(180);
    const rebased = h.prisma.subscriptionItem.update.mock.calls.map((c: any[]) => [c[0].where.id, c[0].data.unitPriceSnapshot]);
    expect(rebased).toEqual([["i-milk", 70], ["i-bread", 40]]);
  });

  it("an APPROVED exception row also bypasses the ceiling", async () => {
    h.state.variants = [variant("milk", 70, 20), variant("bread", 40, 20)];
    h.state.exception = { id: "ex", type: "APPROVED" };
    expect(await generateRoutineOrder(routine(), DAY, null)).toBe("generated");
  });

  it("a PERCENT ceiling is honoured", async () => {
    h.state.variants = [variant("milk", 58, 20), variant("bread", 40, 20)]; // +₹16 on 140; 10% = ₹14
    expect(await generateRoutineOrder(routine({ priceCeilingType: "PERCENT", priceCeilingValue: 10 }), DAY, null)).toBe("held");
  });

  it("fills a missing price baseline on the first automatic run", async () => {
    await generateRoutineOrder(routine({ items: [lineItem("milk", 2, null)] }), DAY, null);
    expect(h.prisma.subscriptionItem.update).toHaveBeenCalledWith({ where: { id: "i-milk" }, data: { unitPriceSnapshot: 50 } });
  });
});

describe("idempotency", () => {
  it("a second run for the same (routine, day) hits the unique key → duplicate, no side effects", async () => {
    h.state.duplicateOrder = true;
    const result = await generateRoutineOrder(routine({ billing: "WALLET" }), DAY, null);
    expect(result).toBe("duplicate");
    expect(h.tx.user.updateMany).not.toHaveBeenCalled(); // wallet is debited AFTER the order insert
    expect(h.generateOrderInvoice).not.toHaveBeenCalled();
    expect(h.notify.notifyNewOrder).not.toHaveBeenCalled();
  });

  it("the order carries the (subscriptionId, subscriptionDate) key the DB constraint enforces", async () => {
    await generateRoutineOrder(routine(), DAY, null);
    expect(orderData()).toMatchObject({ subscriptionId: "sub1", subscriptionDate: DAY });
  });
});

describe("backward compatibility — old single-product subscriptions", () => {
  it("a row with no SubscriptionItems still delivers, via its legacy columns", async () => {
    const legacy = routine({ name: null, productName: "Milk", items: [], variantId: "milk", quantity: 2, isLoose: false, unitPriceSnapshot: 50 });
    expect(await generateRoutineOrder(legacy, DAY, null)).toBe("generated");
    expect(orderData().items.create).toHaveLength(1);
    expect(orderData().items.create[0]).toMatchObject({ variantId: "milk", quantity: 2, unitPrice: 50, lineTotal: 100 });
    expect(orderData().totalAmount).toBe(100);
  });

  it("legacy rows are never re-baselined through a SubscriptionItem that doesn't exist", async () => {
    const legacy = routine({ items: [], variantId: "milk", quantity: 2, isLoose: true, unitPriceSnapshot: 5 });
    await generateRoutineOrder(legacy, DAY, null);
    expect(h.prisma.subscriptionItem.update).not.toHaveBeenCalled();
  });

  it("a legacy LOOSE snapshot (per-base-unit) is ignored as a baseline, so it can't false-trigger a hold", async () => {
    h.state.variants = [variant("tomato", 40, 10, { productType: "PRODUCE", packageSize: 0.5 })];
    const legacy = routine({ items: [], variantId: "tomato", quantity: 2, isLoose: true, unitPriceSnapshot: 1 });
    expect(await generateRoutineOrder(legacy, DAY, null)).toBe("generated");
  });
});

describe("substitution (per-item rule)", () => {
  const swappable = () => routine({ items: [lineItem("milk", 2, 50, "SIMILAR"), lineItem("bread", 1, 40)] });

  it("a SIMILAR item that is out of stock is replaced by an in-stock stand-in; the order carries the stand-in", async () => {
    h.state.variants = [variant("milk", 50, 0), variant("bread", 40, 20)]; // milk is out
    h.state.candidates = [variant("toned", 52, 20)];
    const result = await generateRoutineOrder(swappable(), DAY, null);
    expect(result).toBe("generated");
    expect(orderData().items.create.map((i: any) => i.variantId)).toEqual(["toned", "bread"]);
    expect(orderData().totalAmount).toBe(104 + 40); // 2 × 52 + 40
    expect(h.consumeFifo.mock.calls.map((c) => c[1])).toEqual(["toned", "bread"]);
    expect(h.notify.notifyRoutineSubstituted).toHaveBeenCalledWith("u1", "Morning essentials", [{ itemId: "i-milk", from: "milk", to: "Toned" }]);
    expect(h.notify.notifyRoutineItemsSkipped).not.toHaveBeenCalled();
  });

  it("the stand-in is compared with the ORIGINAL item's normal price, and never becomes its new baseline", async () => {
    h.state.variants = [variant("milk", 50, 0), variant("bread", 40, 20)];
    h.state.candidates = [variant("toned", 52, 20)];
    await generateRoutineOrder(swappable(), DAY, null, { ignoreCeiling: true }); // an approved run re-baselines…
    const rebased = h.prisma.subscriptionItem.update.mock.calls.map((c: any[]) => c[0].where.id);
    expect(rebased).toEqual(["i-bread"]); // …but not the swapped-out line
  });

  it("no suitable stand-in → the item is skipped like before", async () => {
    h.state.variants = [variant("milk", 50, 0), variant("bread", 40, 20)];
    h.state.candidates = [variant("far", 500, 20)]; // way outside the price band
    await generateRoutineOrder(swappable(), DAY, null);
    expect(orderData().items.create.map((i: any) => i.variantId)).toEqual(["bread"]);
    expect(h.notify.notifyRoutineItemsSkipped).toHaveBeenCalledWith("u1", "Morning essentials", ["milk"]);
    expect(h.notify.notifyRoutineSubstituted).not.toHaveBeenCalled();
  });

  it("the default (SKIP) never looks for a stand-in", async () => {
    h.state.variants = [variant("milk", 50, 0), variant("bread", 40, 20)];
    h.state.candidates = [variant("toned", 52, 20)];
    await generateRoutineOrder(routine(), DAY, null); // no rule set
    expect(orderData().items.create.map((i: any) => i.variantId)).toEqual(["bread"]);
    expect(h.prisma.productVariant.findMany).toHaveBeenCalledTimes(1); // only the routine's own variants
  });

  it("a SIMILAR item that IS in stock is left alone (no lookup)", async () => {
    await generateRoutineOrder(swappable(), DAY, null);
    expect(orderData().items.create.map((i: any) => i.variantId)).toEqual(["milk", "bread"]);
    expect(h.prisma.productVariant.findMany).toHaveBeenCalledTimes(1);
  });

  it("the stand-in lookup stays inside the same category and store", async () => {
    h.state.variants = [variant("milk", 50, 0), variant("bread", 40, 20)];
    h.state.candidates = [variant("toned", 52, 20)];
    await generateRoutineOrder(swappable(), DAY, null);
    const where = h.prisma.productVariant.findMany.mock.calls[1]![0].where;
    expect(where.product).toMatchObject({ categoryId: "cat1", sellerId: null, isActive: true, approvalStatus: "APPROVED" });
    expect(where.id.notIn).toEqual(expect.arrayContaining(["milk", "bread"])); // never a product already in the routine
  });
});

describe("price-change alert (ordered within the ceiling)", () => {
  const rise = () => { h.state.variants = [variant("milk", 60, 20), variant("bread", 40, 20)]; }; // +₹20 on 140

  it("alerts once when the run is meaningfully pricier, and remembers the level", async () => {
    rise();
    await generateRoutineOrder(routine(), DAY, null);
    expect(h.notify.notifyRoutinePriceUp).toHaveBeenCalledWith("u1", "Morning essentials", 20, 160);
    expect(h.prisma.subscription.update).toHaveBeenCalledWith({ where: { id: "sub1" }, data: { lastAlertedTotal: 160 } });
  });

  it("does not repeat the alert for the same elevated price the next morning", async () => {
    rise();
    await generateRoutineOrder(routine({ lastAlertedTotal: 160 }), DAY, null);
    expect(h.notify.notifyRoutinePriceUp).not.toHaveBeenCalled();
    expect(h.prisma.subscription.update).not.toHaveBeenCalled();
  });

  it("a small rise is not worth a push", async () => {
    h.state.variants = [variant("milk", 53, 20), variant("bread", 40, 20)]; // +₹6
    await generateRoutineOrder(routine(), DAY, null);
    expect(h.notify.notifyRoutinePriceUp).not.toHaveBeenCalled();
  });

  it("prices back to normal clear the memory, so the next rise alerts again", async () => {
    await generateRoutineOrder(routine({ lastAlertedTotal: 160 }), DAY, null); // 140 = normal
    expect(h.prisma.subscription.update).toHaveBeenCalledWith({ where: { id: "sub1" }, data: { lastAlertedTotal: null } });
    expect(h.notify.notifyRoutinePriceUp).not.toHaveBeenCalled();
  });

  it("a HELD run (above the ceiling) uses the held flow, not this alert", async () => {
    h.state.variants = [variant("milk", 70, 20), variant("bread", 40, 20)]; // +₹40 > ₹30
    await generateRoutineOrder(routine(), DAY, null);
    expect(h.notify.notifyRoutineHeld).toHaveBeenCalled();
    expect(h.notify.notifyRoutinePriceUp).not.toHaveBeenCalled();
  });
});

describe("delivery instructions", () => {
  it("the routine's note is copied onto the generated order", async () => {
    await generateRoutineOrder(routine({ deliveryNote: "Leave it at the door" }), DAY, null);
    expect(orderData().notes).toBe("Leave it at the door");
  });

  it("no note → the order has none (not an empty string)", async () => {
    await generateRoutineOrder(routine(), DAY, null);
    expect(orderData().notes).toBeNull();
  });
});
