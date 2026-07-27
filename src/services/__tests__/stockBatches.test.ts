import { describe, it, expect } from "vitest";
import { applyStockEdit } from "../stockBatches.js";

/**
 * Covers the cost-only edit path of applyStockEdit — the one that used to silently discard an
 * owner's cost-price change, so the field appeared to "revert" on the next read. Both silent
 * failure modes are pinned here: a variant with no StockBatch rows behind its rollup (every
 * pre-FIFO product until backfillStockBatches.ts is run), and a variant whose costPrice is still
 * null. A plain fake tx is enough — applyStockEdit only touches two delegates.
 */
function fakeTx(opts: {
  stock: number;
  costPrice: number | null;
  batches?: Array<{ id: string; qtyRemaining: number; unitCost: number }>;
}) {
  const batches = opts.batches ?? [];
  const calls = { variantUpdates: [] as any[], batchUpdates: [] as any[] };
  const tx = {
    productVariant: {
      findUnique: async () => ({ stock: opts.stock, costPrice: opts.costPrice }),
      update: async (args: any) => {
        calls.variantUpdates.push(args);
        return args;
      },
    },
    stockBatch: {
      findFirst: async () => batches[0] ?? null,
      findMany: async () => batches.map((b) => ({ qtyRemaining: b.qtyRemaining, unitCost: b.unitCost })),
      update: async (args: any) => {
        calls.batchUpdates.push(args);
        const b = batches.find((x) => x.id === args.where.id);
        if (b) b.unitCost = args.data.unitCost;
        return args;
      },
    },
  };
  return { tx, calls };
}

describe("applyStockEdit — cost-only edit", () => {
  it("writes the rollup directly when the variant has no stock batches", async () => {
    const { tx, calls } = fakeTx({ stock: 200, costPrice: 50 });
    await applyStockEdit(tx as any, "v1", 200, 60);
    expect(calls.variantUpdates).toHaveLength(1);
    expect(calls.variantUpdates[0].data.costPrice).toBe(60);
  });

  it("sets a cost on a variant that had none (costPrice was null)", async () => {
    const { tx, calls } = fakeTx({ stock: 10, costPrice: null });
    await applyStockEdit(tx as any, "v1", 10, 42);
    expect(calls.variantUpdates[0].data.costPrice).toBe(42);
  });

  it("reprices the oldest batch and recomputes the rollup when batches exist", async () => {
    const { tx, calls } = fakeTx({
      stock: 20,
      costPrice: 50,
      batches: [{ id: "b1", qtyRemaining: 20, unitCost: 50 }],
    });
    await applyStockEdit(tx as any, "v1", 20, 60);
    expect(calls.batchUpdates).toHaveLength(1);
    expect(calls.batchUpdates[0].data.unitCost).toBe(60);
    expect(calls.variantUpdates[0].data.costPrice).toBe(60);
  });

  it("is a no-op when the cost is unchanged", async () => {
    const { tx, calls } = fakeTx({ stock: 5, costPrice: 50 });
    await applyStockEdit(tx as any, "v1", 5, 50);
    expect(calls.variantUpdates).toHaveLength(0);
    expect(calls.batchUpdates).toHaveLength(0);
  });
});
