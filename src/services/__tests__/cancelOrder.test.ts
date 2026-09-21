import { describe, it, expect } from "vitest";
import { cancelOrderInTx, CANCELLABLE_STATUSES } from "../subOrderFulfillment.js";

/**
 * Pins the exactly-once contract of the cancel compare-and-swap.
 *
 * Every failure mode here is SILENT — nothing on any screen changes, stock quietly drifts upward —
 * which is precisely how the original read-then-write bug survived. restoreConsumption is not
 * idempotent (it double-credits on a second call via its legacy fallback), so "the loser restores
 * nothing" is the whole safety property and is what these assert.
 *
 * A fake transaction client rather than a mocked Prisma: this repo has no vi.mock precedent, and the
 * only thing worth testing is the ORDER of operations and what runs on each branch.
 */
type Call = { op: string; args?: unknown };

function fakeTx(opts: { updatedCount: number; statusAfter?: string; items?: string[] }) {
  const calls: Call[] = [];
  const tx = {
    order: {
      updateMany: async (args: unknown) => {
        calls.push({ op: "order.updateMany", args });
        return { count: opts.updatedCount };
      },
      findUnique: async () => {
        calls.push({ op: "order.findUnique" });
        return opts.statusAfter ? { status: opts.statusAfter } : null;
      },
    },
    orderItem: {
      findMany: async (args: unknown) => {
        calls.push({ op: "orderItem.findMany", args });
        return (opts.items ?? []).map((id) => ({ id }));
      },
      // restoreConsumption's legacy lookup. variantId: null makes the fallback a no-op, so these
      // tests measure "was a restore attempted for this item" without simulating batch arithmetic.
      findUnique: async () => ({ variantId: null, quantity: 1, isLoose: false, stepSize: null }),
    },
    stockBatchConsumption: {
      findMany: async () => {
        calls.push({ op: "stockBatchConsumption.findMany" });
        return [];
      },
      deleteMany: async () => ({ count: 0 }),
    },
    // restoreConsumption's legacy fallback path — reached only if an item was actually restored.
    productVariant: { update: async () => ({}) },
    stockBatch: { findFirst: async () => null, create: async () => ({}), update: async () => ({}) },
  };
  return { tx, calls };
}

describe("cancelOrderInTx", () => {
  it("does NOT touch stock when it loses the compare-and-swap", async () => {
    // count === 0 + already CANCELLED = another cancel path got there first and already restored.
    const { tx, calls } = fakeTx({ updatedCount: 0, statusAfter: "CANCELLED", items: ["i1", "i2"] });

    const outcome = await cancelOrderInTx(tx as never, "order_1");

    expect(outcome).toBe("ALREADY_CANCELLED");
    // The bug: the loser used to restore stock a second time, inflating inventory.
    expect(calls.map((c) => c.op)).not.toContain("orderItem.findMany");
    expect(calls.map((c) => c.op)).not.toContain("stockBatchConsumption.findMany");
  });

  it("reports NOT_CANCELLABLE (not a silent success) when the order was never eligible", async () => {
    const { tx, calls } = fakeTx({ updatedCount: 0, statusAfter: "PACKED" });

    expect(await cancelOrderInTx(tx as never, "order_1")).toBe("NOT_CANCELLABLE");
    expect(calls.map((c) => c.op)).not.toContain("orderItem.findMany");
  });

  it("restores every item exactly once when it wins", async () => {
    const { tx, calls } = fakeTx({ updatedCount: 1, items: ["i1", "i2", "i3"] });

    expect(await cancelOrderInTx(tx as never, "order_1")).toBe("CANCELLED");
    // One restoreConsumption pass per item, and not before the CAS.
    expect(calls[0]!.op).toBe("order.updateMany");
    expect(calls.filter((c) => c.op === "stockBatchConsumption.findMany")).toHaveLength(3);
  });

  it("swaps only FROM a cancellable status, and skips items of an already-cancelled slice", async () => {
    const { tx, calls } = fakeTx({ updatedCount: 1, items: [] });
    await cancelOrderInTx(tx as never, "order_1");

    const cas = calls.find((c) => c.op === "order.updateMany")!.args as {
      where: { status: { in: string[] } };
      data: { status: string };
    };
    expect(cas.where.status.in).toEqual([...CANCELLABLE_STATUSES]);
    expect(cas.data.status).toBe("CANCELLED");

    // A slice a seller already rejected had its stock restored then; restoring it again on a later
    // whole-order cancel was a second, pre-existing double-credit path.
    const items = calls.find((c) => c.op === "orderItem.findMany")!.args as {
      where: { OR: unknown[] };
    };
    expect(items.where.OR).toEqual([
      { subOrderId: null },
      { subOrder: { status: { not: "CANCELLED" } } },
    ]);
  });

  it("honours a caller-narrowed allowedFrom (owner/admin pass the order's current status)", async () => {
    const { tx, calls } = fakeTx({ updatedCount: 1, items: [] });
    await cancelOrderInTx(tx as never, "order_1", ["CONFIRMED"]);

    const cas = calls.find((c) => c.op === "order.updateMany")!.args as {
      where: { status: { in: string[] } };
    };
    expect(cas.where.status.in).toEqual(["CONFIRMED"]);
  });
});
