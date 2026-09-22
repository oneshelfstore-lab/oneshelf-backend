import { describe, it, expect } from "vitest";
import { payoutSellerInTx, payableSubOrderWhere, planAdjustmentAbsorption } from "../sellerPayout.js";

/**
 * Pins the exactly-once claim in the seller payout.
 *
 * Both failure modes move real money and are invisible on every screen: pay the same orders twice
 * (outstandingBalance decremented twice, two SellerPayout rows for one set of orders), or pay for
 * orders another payout already claimed. The guard is the `settled: false` filter on the settle —
 * these assert it is there and that a short claim aborts instead of transferring a wrong amount.
 *
 * Fake transaction client rather than a mocked Prisma: this repo has no vi.mock precedent, and what
 * matters is which writes happen on each branch, not batch arithmetic.
 */
type Call = { op: string; args?: any };

const SUB = (id: string) => ({
  id, subtotal: 100, commissionAmount: 5, tcsAmount: 0, tdsAmount: 0, netPayable: 95,
});

function fakeTx(opts: {
  unsettled: string[];
  houseIsSeparate?: boolean;
  claimedCount?: number;
  heldNet?: number;
  heldCount?: number;
  adjustments?: { id: string; amount: number; reason: string }[];
  adjClaimedCount?: number;
}) {
  const calls: Call[] = [];
  const adjustments = opts.adjustments ?? [];
  const tx = {
    subOrderAdjustment: {
      findMany: async (args: any) => {
        calls.push({ op: "subOrderAdjustment.findMany", args });
        return adjustments;
      },
      updateMany: async (args: any) => {
        calls.push({ op: "subOrderAdjustment.updateMany", args });
        return { count: opts.adjClaimedCount ?? args.where.id.in.length };
      },
      create: async (args: any) => {
        calls.push({ op: "subOrderAdjustment.create", args });
        return { id: "adj_new" };
      },
    },
    subOrder: {
      findMany: async (args: any) => {
        calls.push({ op: "subOrder.findMany", args });
        return opts.unsettled.map(SUB);
      },
      updateMany: async (args: any) => {
        calls.push({ op: "subOrder.updateMany", args });
        return { count: opts.claimedCount ?? opts.unsettled.length };
      },
      // Only reached on the nothing-payable branch, to tell "you have no orders" apart from
      // "your orders have not been delivered yet".
      aggregate: async (args: any) => {
        calls.push({ op: "subOrder.aggregate", args });
        return { _sum: { netPayable: opts.heldNet ?? 0 }, _count: { _all: opts.heldCount ?? 0 } };
      },
    },
    sellerPayout: {
      create: async (args: any) => {
        calls.push({ op: "sellerPayout.create", args });
        return { id: "payout_1", ...args.data };
      },
    },
    seller: {
      update: async (args: any) => {
        calls.push({ op: "seller.update", args });
        return {};
      },
    },
    tdsRecord: { create: async (args: any) => { calls.push({ op: "tdsRecord.create", args }); return {}; } },
    // The step-09 entity-split flag, read by the guard at the top of payoutSellerInTx. False here:
    // the platform and the shop are one entity, which is what makes paying the house store refuse.
    storeConfig: { findFirst: async () => ({ houseSellerIsSeparateEntity: opts.houseIsSeparate ?? false }) },
  };
  return { tx, calls };
}

const SELLER = { id: "s1", name: "Aman Medicos", pan: null, isHouse: false };
const HOUSE_SELLER = { id: "house", name: "Oneshelf", pan: null, isHouse: true };

describe("payoutSellerInTx", () => {
  it("settles ONLY rows still unsettled — the claim carries settled: false", async () => {
    const { tx, calls } = fakeTx({ unsettled: ["a", "b"] });

    await payoutSellerInTx(tx as never, "s1", SELLER);

    const claim = calls.find((c) => c.op === "subOrder.updateMany")!.args;
    // Without this filter a concurrent payout re-matches the same rows and pays them again.
    expect(claim.where.settled).toBe(false);
    expect(claim.where.id.in).toEqual(["a", "b"]);
  });

  it("does NOT decrement the balance when another payout claimed some rows first", async () => {
    // 2 candidates read, only 1 actually claimed ⇒ the computed totals are already wrong.
    const { tx, calls } = fakeTx({ unsettled: ["a", "b"], claimedCount: 1 });

    await expect(payoutSellerInTx(tx as never, "s1", SELLER)).rejects.toThrow(/another payout/i);

    // The whole transaction must roll back rather than transfer a partly-correct amount.
    expect(calls.map((c) => c.op)).not.toContain("seller.update");
  });

  it("decrements by the summed netPayable exactly once on a clean claim", async () => {
    const { tx, calls } = fakeTx({ unsettled: ["a", "b", "c"] });

    const res = await payoutSellerInTx(tx as never, "s1", SELLER);

    const decs = calls.filter((c) => c.op === "seller.update");
    expect(decs).toHaveLength(1);
    expect(decs[0]!.args.data.outstandingBalance.decrement).toBe(285); // 3 × 95
    expect(res.count).toBe(3);
  });

  it("reports the CLAIMED count, not the pre-read count", async () => {
    // Guards against reverting to `count: unsettled.length`, which would report orders as paid
    // that the claim never actually settled.
    const { tx } = fakeTx({ unsettled: ["a", "b"] });
    const res = await payoutSellerInTx(tx as never, "s1", SELLER);
    expect(res.count).toBe(2);
  });

  it("refuses an empty ledger before writing anything", async () => {
    const { tx, calls } = fakeTx({ unsettled: [] });

    await expect(payoutSellerInTx(tx as never, "s1", SELLER)).rejects.toThrow(/nothing to pay out/i);
    expect(calls.map((c) => c.op)).not.toContain("sellerPayout.create");
  });

  // The guard below changes what "nothing to pay out" can mean: a seller may be owed real money and
  // still have none of it payable. Saying only "nothing to pay out" against a screen showing ₹693
  // owed reads as a broken button, so the refusal has to name the held amount.
  it("names the held amount when money is owed but nothing has been delivered", async () => {
    const { tx, calls } = fakeTx({ unsettled: [], heldNet: 693.72, heldCount: 4 });

    await expect(payoutSellerInTx(tx as never, "s1", SELLER)).rejects.toThrow(/693\.72.*4 order/i);
    expect(calls.map((c) => c.op)).not.toContain("sellerPayout.create");
  });

  it("mentions the hold window in that refusal only when one is configured", async () => {
    const withHold = fakeTx({ unsettled: [], heldNet: 100, heldCount: 1 });
    await expect(
      payoutSellerInTx(withHold.tx as never, "s1", SELLER, { payoutHoldDays: 3 }),
    ).rejects.toThrow(/3-day hold/i);

    const noHold = fakeTx({ unsettled: [], heldNet: 100, heldCount: 1 });
    await expect(payoutSellerInTx(noHold.tx as never, "s1", SELLER)).rejects.not.toThrow(/hold/i);
  });

  it("asks only for delivered slices", async () => {
    const { tx, calls } = fakeTx({ unsettled: ["a"] });

    await payoutSellerInTx(tx as never, "s1", SELLER);

    const where = calls.find((c) => c.op === "subOrder.findMany")!.args.where;
    expect(where.order.status).toBe("DELIVERED");
    expect(where.settled).toBe(false);
    expect(where.status).toEqual({ not: "CANCELLED" });
  });
});

/**
 * The filter itself. Every way it can be wrong is silent money: too loose pays a seller for goods
 * still in a rider's bag, too strict strands a delivered order's payout forever.
 */
describe("payableSubOrderWhere", () => {
  const NOW = new Date("2026-09-21T12:00:00.000Z");

  it("requires the parent order to be DELIVERED", () => {
    expect(payableSubOrderWhere({ payoutHoldDays: 0 }).order).toEqual({ status: "DELIVERED" });
  });

  it("still excludes a slice the seller rejected on an order others delivered", () => {
    expect(payableSubOrderWhere({ payoutHoldDays: 0 }).status).toEqual({ not: "CANCELLED" });
  });

  it("adds NO deliveredAt condition when the hold is zero", () => {
    // Load-bearing: a DELIVERED order with a null deliveredAt would otherwise be permanently
    // unpayable the day someone sets a hold, and nothing enforces that column being populated.
    const order = payableSubOrderWhere({ payoutHoldDays: 0, now: NOW }).order as any;
    expect(order.deliveredAt).toBeUndefined();
  });

  it("holds back anything delivered inside the window", () => {
    const order = payableSubOrderWhere({ payoutHoldDays: 3, now: NOW }).order as any;
    expect(order.deliveredAt.lte).toEqual(new Date("2026-09-18T12:00:00.000Z"));
  });

  it("treats a negative hold as no hold rather than paying out the future", () => {
    const order = payableSubOrderWhere({ payoutHoldDays: -5, now: NOW }).order as any;
    expect(order.deliveredAt).toBeUndefined();
  });

  it("scopes to one seller only when asked, so the cron can sum across all of them", () => {
    expect(payableSubOrderWhere({ sellerId: "s1", payoutHoldDays: 0 }).sellerId).toBe("s1");
    expect(payableSubOrderWhere({ payoutHoldDays: 0 }).sellerId).toBeUndefined();
  });
});

/**
 * Absorbing adjustments into a payout. A clawback recovers money already paid to a seller, so every
 * way this can be wrong moves real money in the wrong direction and shows up on no screen: absorb
 * twice and the seller is underpaid; absorb nothing and the platform eats it; let the net go
 * negative and a "payout" becomes an invoice to the seller wearing a payout's clothes.
 */
describe("planAdjustmentAbsorption", () => {
  const debt = (id: string, amount: number, reason = "cancelled after payout") => ({ id, amount, reason });

  it("does nothing when there is nothing to absorb", () => {
    expect(planAdjustmentAbsorption(500, [])).toEqual({ claimIds: [], applied: 0, carryForward: null });
  });

  it("absorbs a clawback that fits, with nothing carried forward", () => {
    const plan = planAdjustmentAbsorption(600, [debt("a", -500)]);
    expect(plan.applied).toBe(-500);
    expect(plan.claimIds).toEqual(["a"]);
    expect(plan.carryForward).toBeNull();
  });

  // The case the whole design turns on. Refusing the payout here would strand the seller's 100
  // over a 500 debt; letting it through unfloored would compute a NEGATIVE payout.
  it("floors at zero and carries the remainder when the clawback is bigger than the payout", () => {
    const plan = planAdjustmentAbsorption(100, [debt("a", -500)]);
    expect(plan.applied).toBe(-100);
    expect(plan.claimIds).toEqual(["a"]);
    expect(plan.carryForward).toEqual({
      fromId: "a",
      amount: -400,
      reason: expect.stringContaining("Carried forward"),
    });
  });

  it("never lets the resulting payout go negative, whatever the debt", () => {
    for (const [sub, owed] of [[0, -900], [1, -900], [100, -500], [499.99, -500]]) {
      const plan = planAdjustmentAbsorption(sub!, [debt("a", owed!)]);
      expect(sub! + plan.applied).toBeGreaterThanOrEqual(0);
    }
  });

  it("pays a credit even when there are no orders to pay for", () => {
    const plan = planAdjustmentAbsorption(0, [{ id: "c", amount: 4.19, reason: "rate correction" }]);
    expect(plan.applied).toBe(4.19);
    expect(plan.claimIds).toEqual(["c"]);
  });

  // Credits first is deliberate: a seller owed a correction should get it in the same batch that
  // recovers a debt, not watch the debt eat the batch while their credit waits for the next one.
  it("applies credits before debts, so a credit widens what a debt can be absorbed against", () => {
    const plan = planAdjustmentAbsorption(0, [debt("d", -50), { id: "c", amount: 50, reason: "correction" }]);
    expect(plan.claimIds).toEqual(["c", "d"]);
    expect(plan.applied).toBe(0);
    expect(plan.carryForward).toBeNull();
  });

  it("leaves a debt it cannot touch completely alone rather than half-claiming it", () => {
    const plan = planAdjustmentAbsorption(100, [debt("a", -100), debt("b", -200)]);
    expect(plan.claimIds).toEqual(["a"]);
    expect(plan.applied).toBe(-100);
    expect(plan.carryForward).toBeNull();
  });

  it("carries forward at most once, since nothing can be absorbed after the payout hits zero", () => {
    const plan = planAdjustmentAbsorption(50, [debt("a", -80), debt("b", -80)]);
    expect(plan.claimIds).toEqual(["a"]);
    expect(plan.carryForward?.amount).toBe(-30);
  });

  it("leaves no floating-point tail on a partial absorption", () => {
    const plan = planAdjustmentAbsorption(33.33, [debt("a", -100)]);
    expect(plan.applied).toBe(-33.33);
    expect(plan.carryForward?.amount).toBe(-66.67);
    expect(33.33 + plan.applied).toBe(0);
  });
});

describe("payoutSellerInTx — adjustments", () => {
  it("reduces the payout by the clawback and records it as its own line", async () => {
    // 3 slices x 95 = 285 payable, less a 100 clawback.
    const { tx, calls } = fakeTx({
      unsettled: ["a", "b", "c"],
      adjustments: [{ id: "adj1", amount: -100, reason: "cancelled after payout" }],
    });

    await payoutSellerInTx(tx as never, "s1", SELLER);

    const row = calls.find((c) => c.op === "sellerPayout.create")!.args.data;
    expect(row.netPaid).toBe(185);
    // Recorded separately, not folded in — otherwise the row's own arithmetic stops closing.
    expect(row.adjustmentTotal).toBe(-100);
    expect(row.grossAmount - row.commission - row.tcs - row.tds + row.adjustmentTotal).toBe(row.netPaid);
    // And the balance drops by the NET, not by the pre-adjustment figure — the clawback already
    // took its share when it was written.
    expect(calls.find((c) => c.op === "seller.update")!.args.data.outstandingBalance.decrement).toBe(185);
  });

  it("claims adjustments with settled: false, the same guard the sub-orders get", async () => {
    const { tx, calls } = fakeTx({
      unsettled: ["a"],
      adjustments: [{ id: "adj1", amount: -10, reason: "x" }],
    });

    await payoutSellerInTx(tx as never, "s1", SELLER);

    const claim = calls.find((c) => c.op === "subOrderAdjustment.updateMany")!.args;
    expect(claim.where.settled).toBe(false);
    expect(claim.where.id.in).toEqual(["adj1"]);
    expect(claim.data.settled).toBe(true);
  });

  it("aborts without touching the balance when another payout claimed an adjustment first", async () => {
    const { tx, calls } = fakeTx({
      unsettled: ["a"],
      adjustments: [{ id: "adj1", amount: -10, reason: "x" }],
      adjClaimedCount: 0,
    });

    await expect(payoutSellerInTx(tx as never, "s1", SELLER)).rejects.toThrow(/another payout/i);
    expect(calls.map((c) => c.op)).not.toContain("seller.update");
  });

  it("carries an oversized clawback forward instead of refusing the payout", async () => {
    // 95 payable against a 500 debt: pay 0 now, carry 405, do NOT strand the seller's other money.
    const { tx, calls } = fakeTx({
      unsettled: ["a"],
      adjustments: [{ id: "adj1", amount: -500, reason: "cancelled after payout" }],
    });

    await payoutSellerInTx(tx as never, "s1", SELLER);

    expect(calls.find((c) => c.op === "sellerPayout.create")!.args.data.netPaid).toBe(0);
    const carried = calls.find((c) => c.op === "subOrderAdjustment.create")!.args.data;
    expect(carried.amount).toBe(-405);
    expect(carried.kind).toBe("CLAWBACK");
    expect(carried.settled).toBeUndefined(); // defaults open, so the next payout picks it up
  });

  it("writes no carry-forward row when the clawback was absorbed in full", async () => {
    const { tx, calls } = fakeTx({
      unsettled: ["a", "b"],
      adjustments: [{ id: "adj1", amount: -50, reason: "x" }],
    });

    await payoutSellerInTx(tx as never, "s1", SELLER);

    expect(calls.map((c) => c.op)).not.toContain("subOrderAdjustment.create");
  });

  it("pays a seller owed only a correction, with no orders at all", async () => {
    const { tx, calls } = fakeTx({
      unsettled: [],
      adjustments: [{ id: "adj1", amount: 4.19, reason: "TCS rate correction" }],
    });

    await payoutSellerInTx(tx as never, "s1", SELLER);

    expect(calls.find((c) => c.op === "sellerPayout.create")!.args.data.netPaid).toBe(4.19);
  });

  it("still refuses when the only thing outstanding is a debt", async () => {
    // Nothing to recover it against. It waits rather than producing a negative transfer.
    const { tx, calls } = fakeTx({
      unsettled: [],
      adjustments: [{ id: "adj1", amount: -100, reason: "x" }],
    });

    await expect(payoutSellerInTx(tx as never, "s1", SELLER)).rejects.toThrow();
    expect(calls.map((c) => c.op)).not.toContain("sellerPayout.create");
  });
});

/**
 * ⚠️ The guard that sat one level too high. It lived in payoutSeller, the polite entrance, while
 * payoutSellerInTx — the function that actually writes — had none. A prove script importing the
 * inner function walked straight past it, with 8 house slices and ₹7,463 of net behind it.
 */
describe("payoutSellerInTx — the house store", () => {
  it("refuses to pay the house store while it is the same legal entity", async () => {
    const { tx } = fakeTx({ unsettled: ["a", "b"] });
    await expect(payoutSellerInTx(tx as never, "house", HOUSE_SELLER)).rejects.toThrow(/house store/i);
  });

  it("writes nothing at all when it refuses", async () => {
    const { tx, calls } = fakeTx({ unsettled: ["a", "b"] });
    await expect(payoutSellerInTx(tx as never, "house", HOUSE_SELLER)).rejects.toThrow();
    expect(calls.filter((c) => /create|update/.test(c.op))).toEqual([]);
  });

  // Step 23 flips this. The house store then has a real ledger and must be payable like any seller.
  it("lets it through once the shop is a separate legal entity", async () => {
    const { tx, calls } = fakeTx({ unsettled: ["a", "b"], houseIsSeparate: true });
    await payoutSellerInTx(tx as never, "house", HOUSE_SELLER);
    expect(calls.some((c) => c.op === "sellerPayout.create")).toBe(true);
  });

  it("still pays an external seller, flag either way", async () => {
    for (const houseIsSeparate of [false, true]) {
      const { tx, calls } = fakeTx({ unsettled: ["a"], houseIsSeparate });
      await payoutSellerInTx(tx as never, "s1", SELLER);
      expect(calls.some((c) => c.op === "sellerPayout.create")).toBe(true);
    }
  });
});
