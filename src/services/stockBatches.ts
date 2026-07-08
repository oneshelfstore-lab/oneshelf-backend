import type { Prisma } from "@prisma/client";
import { AppError } from "../lib/errors.js";

// ─── FIFO batch costing engine ───────────────────────────────────────
//
// Each restock creates its own StockBatch at whatever cost it actually came in at, instead of
// overwriting ProductVariant.costPrice in place. Sales consume the oldest batch first (FIFO) and
// snapshot exactly what was drawn onto the sale record (OrderItem.costPriceSnapshot), so margin
// stays historically correct even after a later restock changes cost.
//
// ProductVariant.stock/costPrice remain denormalized rollups this engine keeps in sync on every
// call — every existing reader (cart validation, catalog display, low-stock threshold, seller
// earnings) keeps working unchanged. Do not write those two fields directly anywhere else; always
// go through receiveBatch/consumeFifo/restoreConsumption.

export interface BatchConsumption {
  batchId: string;
  qty: number;
  unitCost: number;
}

export interface ConsumeResult {
  consumed: BatchConsumption[];
  totalQty: number;
  // Weighted average cost of what was actually drawn for THIS consumption (not the variant's
  // overall rollup) — this is what gets snapshotted onto costPriceSnapshot.
  weightedUnitCost: number;
}

export type ConsumptionRef = { orderItemId: string } | { invoiceLineItemId: string };

/** Recompute + persist ProductVariant.costPrice as the weighted-average cost across all batches
 *  still holding stock. Called after any batch qtyRemaining change. If nothing remains, the last
 *  known costPrice is left alone (nothing left to average — not the same as "cost is now 0"). */
async function recomputeRollupCost(tx: Prisma.TransactionClient, variantId: string): Promise<void> {
  const batches = await tx.stockBatch.findMany({
    where: { variantId, qtyRemaining: { gt: 0 } },
    select: { qtyRemaining: true, unitCost: true },
  });
  if (batches.length === 0) return;

  let totalQty = 0;
  let totalCost = 0;
  for (const b of batches) {
    const q = Number(b.qtyRemaining);
    totalQty += q;
    totalCost += q * Number(b.unitCost);
  }
  if (totalQty <= 0) return;
  await tx.productVariant.update({ where: { id: variantId }, data: { costPrice: totalCost / totalQty } });
}

/**
 * Restock at a (possibly new) cost. Creates a fresh batch, bumps the ProductVariant.stock rollup,
 * and recomputes costPrice as the weighted average across every batch still holding stock. This is
 * the ONLY place a genuinely different cost should enter the system — the quick +/- stepper calls
 * this too, but defaults unitCost to the variant's current rollup cost (a same-cost top-up).
 */
export async function receiveBatch(
  tx: Prisma.TransactionClient,
  variantId: string,
  qty: number,
  unitCost: number,
  note?: string,
): Promise<{ batchId: string }> {
  if (qty <= 0) throw new AppError(400, "VALIDATION_ERROR", "Restock quantity must be greater than 0");
  if (unitCost < 0) throw new AppError(400, "VALIDATION_ERROR", "Unit cost cannot be negative");

  const batch = await tx.stockBatch.create({
    data: { variantId, unitCost, qtyReceived: qty, qtyRemaining: qty, note: note ?? null },
  });
  await tx.productVariant.update({ where: { id: variantId }, data: { stock: { increment: qty } } });
  await recomputeRollupCost(tx, variantId);
  return { batchId: batch.id };
}

/**
 * Atomically consume `qtyNeeded` base-units of stock, oldest batch first (FIFO). Replaces the
 * single guarded `updateMany({stock: {gte: needed}})` this codebase used before batches existed —
 * same atomicity guarantee, just walking N rows instead of one: each batch decrement is itself a
 * guarded updateMany (qtyRemaining >= amount taken), so a concurrent consumer can never take more
 * than what's actually left in that batch at the moment of the write. On a lost race against a
 * concurrent draw on the same batch, this re-reads that batch's live remaining amount and retries
 * with whatever's actually left before moving on — so contention degrades to a few extra reads,
 * never to an incorrect "insufficient stock" reject.
 *
 * Throws INSUFFICIENT_STOCK (rolling back the caller's transaction) if the walk runs out of
 * batches before `qtyNeeded` is satisfied — identical externally-visible behavior to before.
 *
 * Does NOT write StockBatchConsumption rows — the caller does that once the sale record (OrderItem
 * / InvoiceLineItem) it belongs to actually has an id, using the returned `consumed` breakdown.
 */
export async function consumeFifo(
  tx: Prisma.TransactionClient,
  variantId: string,
  qtyNeeded: number,
): Promise<ConsumeResult> {
  if (qtyNeeded <= 0) return { consumed: [], totalQty: 0, weightedUnitCost: 0 };

  const batches = await tx.stockBatch.findMany({
    where: { variantId, qtyRemaining: { gt: 0 } },
    orderBy: { receivedAt: "asc" },
    select: { id: true, qtyRemaining: true, unitCost: true },
  });

  const consumed: BatchConsumption[] = [];
  let remaining = qtyNeeded;
  let totalCost = 0;

  for (const batch of batches) {
    if (remaining <= 0) break;
    let liveRemaining = Number(batch.qtyRemaining);

    while (remaining > 0 && liveRemaining > 0) {
      const take = Math.min(remaining, liveRemaining);
      const updated = await tx.stockBatch.updateMany({
        where: { id: batch.id, qtyRemaining: { gte: take } },
        data: { qtyRemaining: { decrement: take } },
      });
      if (updated.count > 0) {
        consumed.push({ batchId: batch.id, qty: take, unitCost: Number(batch.unitCost) });
        totalCost += take * Number(batch.unitCost);
        remaining -= take;
        break;
      }
      // Lost a race — someone else drew from this batch between our read and our write.
      const fresh = await tx.stockBatch.findUnique({ where: { id: batch.id }, select: { qtyRemaining: true } });
      liveRemaining = fresh ? Number(fresh.qtyRemaining) : 0;
    }
  }

  if (remaining > 0) {
    throw new AppError(400, "INSUFFICIENT_STOCK", "Insufficient stock");
  }

  await tx.productVariant.update({ where: { id: variantId }, data: { stock: { decrement: qtyNeeded } } });
  await recomputeRollupCost(tx, variantId);

  return { consumed, totalQty: qtyNeeded, weightedUnitCost: qtyNeeded > 0 ? totalCost / qtyNeeded : 0 };
}

/**
 * Persist the StockBatchConsumption rows for a completed FIFO draw, once the sale record it
 * belongs to has a real id. Call this right after creating the OrderItem/InvoiceLineItem that
 * `consumeFifo`'s result is for.
 */
export async function recordConsumption(
  tx: Prisma.TransactionClient,
  ref: ConsumptionRef,
  consumed: BatchConsumption[],
): Promise<void> {
  if (consumed.length === 0) return;
  await tx.stockBatchConsumption.createMany({
    data: consumed.map((c) => ({
      batchId: c.batchId,
      qty: c.qty,
      ...("orderItemId" in ref ? { orderItemId: ref.orderItemId } : { invoiceLineItemId: ref.invoiceLineItemId }),
    })),
  });
}

/** Base-unit quantity a sale record actually drew (loose items store an increment count, not the
 *  base-unit amount) — same convention used at consumeFifo call sites. */
function baseUnitQty(row: { quantity: Prisma.Decimal | number; isLoose: boolean; stepSize: Prisma.Decimal | number | null }): number {
  return row.isLoose && row.stepSize != null ? Number(row.quantity) * Number(row.stepSize) : Number(row.quantity);
}

/**
 * Credit a restored qty back into the batch ledger when there's no StockBatchConsumption trail to
 * reverse (a pre-batch-system sale — see restoreConsumption below). Goes into the variant's oldest
 * existing batch, or a new zero-cost "untracked" batch if none exists, so ProductVariant.stock and
 * SUM(StockBatch.qtyRemaining) never drift apart even for this legacy edge case.
 */
async function creditLegacyRestore(tx: Prisma.TransactionClient, variantId: string, qty: number): Promise<void> {
  if (qty <= 0) return;
  const oldest = await tx.stockBatch.findFirst({ where: { variantId }, orderBy: { receivedAt: "asc" }, select: { id: true } });
  if (oldest) {
    await tx.stockBatch.update({ where: { id: oldest.id }, data: { qtyReceived: { increment: qty }, qtyRemaining: { increment: qty } } });
  } else {
    await tx.stockBatch.create({
      data: { variantId, unitCost: 0, qtyReceived: qty, qtyRemaining: qty, note: "Restored from a pre-batch-system order (no cost data available)" },
    });
  }
  await tx.productVariant.update({ where: { id: variantId }, data: { stock: { increment: qty } } });
  await recomputeRollupCost(tx, variantId);
}

/**
 * Reverse everything drawn against one sale record (an OrderItem or InvoiceLineItem) — used on
 * cancel/reject/expiry. Adds each drawn qty back onto its originating batch, then bumps the
 * variant's stock rollup once per affected variant. Deletes the consumption rows it just reversed,
 * so a duplicate/defensive second call becomes a safe no-op instead of a double-restore — this
 * also lets substitution reuse the SAME orderItemId for two different products in sequence
 * (restore the original's batches, then record the substitute's draw under that same id).
 *
 * Legacy fallback: an OrderItem/InvoiceLineItem sold BEFORE this batch system existed has no
 * StockBatchConsumption trail at all (the old code just decremented the flat stock field directly).
 * Rather than silently no-op — which would leave that unit permanently missing from stock the
 * moment its order is cancelled — this reads the sale record's own quantity/variant and credits the
 * restore via creditLegacyRestore, so the rollup stays correct even across the migration boundary.
 * A record found with `variantId: null` (deleted variant) can't be restored to anything — same as
 * the pre-batch code, which also had nothing to increment in that case.
 */
export async function restoreConsumption(tx: Prisma.TransactionClient, ref: ConsumptionRef): Promise<void> {
  const where = "orderItemId" in ref ? { orderItemId: ref.orderItemId } : { invoiceLineItemId: ref.invoiceLineItemId };
  const consumptions = await tx.stockBatchConsumption.findMany({
    where,
    select: { id: true, batchId: true, qty: true, batch: { select: { variantId: true } } },
  });

  if (consumptions.length === 0) {
    // Nothing recorded — either a pre-migration sale (fall back below) or this ref was already
    // restored once (deleteMany below makes a second call a safe no-op either way).
    if ("orderItemId" in ref) {
      const item = await tx.orderItem.findUnique({
        where: { id: ref.orderItemId },
        select: { variantId: true, quantity: true, isLoose: true, stepSize: true },
      });
      if (item?.variantId) await creditLegacyRestore(tx, item.variantId, baseUnitQty(item));
    } else {
      const line = await tx.invoiceLineItem.findUnique({
        where: { id: ref.invoiceLineItemId },
        select: { variantId: true, quantity: true },
      });
      // Legacy POS lines have no isLoose/stepSize (that concept is app-order-only) — quantity is
      // already in base units for POS billing.
      if (line?.variantId) await creditLegacyRestore(tx, line.variantId, Number(line.quantity));
    }
    return;
  }

  const byVariant = new Map<string, number>();
  for (const c of consumptions) {
    await tx.stockBatch.update({ where: { id: c.batchId }, data: { qtyRemaining: { increment: c.qty } } });
    byVariant.set(c.batch.variantId, (byVariant.get(c.batch.variantId) ?? 0) + Number(c.qty));
  }
  await tx.stockBatchConsumption.deleteMany({ where });

  for (const [variantId, qty] of byVariant) {
    await tx.productVariant.update({ where: { id: variantId }, data: { stock: { increment: qty } } });
    await recomputeRollupCost(tx, variantId);
  }
}

/** Current weighted-average cost across a variant's remaining batches. Same math recomputeRollupCost
 *  persists onto ProductVariant.costPrice — exposed standalone for prefilling the "Restock" dialog
 *  and for the analytics stock-valuation fix. Returns null if the variant has no batch data at all
 *  (falls back to the variant's own costPrice at the call site, same as before batches existed). */
export async function weightedAverageCost(tx: Prisma.TransactionClient, variantId: string): Promise<number | null> {
  const batches = await tx.stockBatch.findMany({
    where: { variantId, qtyRemaining: { gt: 0 } },
    select: { qtyRemaining: true, unitCost: true },
  });
  if (batches.length === 0) return null;
  let totalQty = 0;
  let totalCost = 0;
  for (const b of batches) {
    const q = Number(b.qtyRemaining);
    totalQty += q;
    totalCost += q * Number(b.unitCost);
  }
  return totalQty > 0 ? totalCost / totalQty : null;
}

/**
 * Apply a full-editor stock EDIT (owner/seller product form sets an absolute new stock number,
 * possibly alongside a new cost) — as opposed to consumeFifo/receiveBatch, which model a real
 * sale/restock event directly. Diffs against the variant's current rollup and routes the delta
 * through the right primitive so ProductVariant.stock/costPrice never get written outside this
 * service:
 *  - stock went UP → receiveBatch (a restock, at newCostPrice if given, else the current weighted
 *    average) — this is the path a genuinely different cost enters the system from the editor,
 *    same as the dedicated Restock action.
 *  - stock went DOWN → consumeFifo with no consumption record (a shrinkage/miscount correction,
 *    same bookkeeping shape as a free-sample draw — there's no sale to attach it to).
 *  - stock UNCHANGED but a different cost was typed → corrects the OLDEST remaining batch's cost
 *    directly (a data-entry fix to what was already received, not a new purchase) rather than
 *    inventing a zero-qty batch. A no-op if there's no batch yet (nothing to correct).
 */
export async function applyStockEdit(
  tx: Prisma.TransactionClient,
  variantId: string,
  newStock: number,
  newCostPrice?: number | null,
  note?: string,
): Promise<void> {
  const variant = await tx.productVariant.findUnique({ where: { id: variantId }, select: { stock: true, costPrice: true } });
  if (!variant) return;
  const currentStock = Number(variant.stock);
  const delta = newStock - currentStock;
  const EPS = 1e-9;

  if (delta > EPS) {
    await receiveBatch(tx, variantId, delta, newCostPrice ?? (variant.costPrice != null ? Number(variant.costPrice) : 0), note);
  } else if (delta < -EPS) {
    try {
      await consumeFifo(tx, variantId, -delta);
    } catch (e) {
      if (e instanceof AppError && e.code === "INSUFFICIENT_STOCK") {
        // Shouldn't happen (delta is derived from the live rollup just read above) except under a
        // genuine concurrent-write race — surface it rather than silently diverging from what the
        // editor displayed.
        throw new AppError(409, "STOCK_CHANGED", "Stock changed while saving — please reload and try again.");
      }
      throw e;
    }
  } else if (newCostPrice != null && variant.costPrice != null && Math.abs(newCostPrice - Number(variant.costPrice)) > EPS) {
    const oldest = await tx.stockBatch.findFirst({
      where: { variantId, qtyRemaining: { gt: 0 } },
      orderBy: { receivedAt: "asc" },
      select: { id: true },
    });
    if (oldest) {
      await tx.stockBatch.update({ where: { id: oldest.id }, data: { unitCost: newCostPrice } });
      await recomputeRollupCost(tx, variantId);
    }
  }
}
