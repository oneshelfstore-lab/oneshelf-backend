import { describe, it, expect } from "vitest";
import { payoutSellerInTx } from "../sellerPayout.js";

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

function fakeTx(opts: { unsettled: string[]; claimedCount?: number }) {
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
});
