import { describe, it, expect } from "vitest";
import { payoutSellerInTx, payableSubOrderWhere } from "../sellerPayout.js";

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

function fakeTx(opts: { unsettled: string[]; claimedCount?: number; heldNet?: number; heldCount?: number }) {
  const calls: Call[] = [];
  const tx = {
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
  };
  return { tx, calls };
}

const SELLER = { id: "s1", name: "Aman Medicos", pan: null };

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
