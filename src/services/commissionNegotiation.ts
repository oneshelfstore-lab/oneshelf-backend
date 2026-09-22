import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";
import { resolveCommissionPct } from "./sellerSplit.js";

/**
 * Per-product commission negotiation (runbook step 20).
 *
 * A flat rate across a seller's whole catalogue is wrong wherever their own margin is thin — staples
 * run on 2–3% while packaged snacks run on 15%. The seller asks for a different rate on one product,
 * the owner approves, counters or rejects, and the answer lands on
 * `CatalogProduct.commissionPctOverride`, which is what step 08's per-line resolution reads.
 *
 * ⚠️ THE RATE AND THE RECORD LIVE IN TWO PLACES ON PURPOSE. The override is a single cheap field the
 * pricing path reads on every order. This table is the audit trail of WHY, and it has to survive the
 * rate being changed again later — so it can never be the thing the money math consults.
 *
 * ⚠️ The floor at 0 is enforced by a database CHECK, not here and not in the app. A negative
 * commission is the platform paying the seller a fee — a supply in the opposite direction that
 * nothing downstream is built for. Validating it in one route leaves every other writer free.
 */

const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);

/** How far back the owner's queue looks when sizing a request. */
export const IMPACT_WINDOW_DAYS = 30;

export interface CommissionRequestView {
  id: string;
  productId: string;
  productName: string;
  sellerId: string;
  sellerName: string;
  currentPct: number;
  requestedPct: number;
  approvedPct: number | null;
  /** The rate in force on this product RIGHT NOW — may differ from currentPct if it moved since. */
  effectivePctNow: number;
  sellerNote: string | null;
  ownerNote: string | null;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  /** Taxable sales of this product through the platform over the impact window. */
  windowTaxable: number;
  windowOrderCount: number;
  /** What the platform earned on it in that window, at the rate actually applied. */
  windowCommission: number;
  /**
   * What the platform would have earned instead at the REQUESTED rate, over the same window.
   * ⚠️ A hypothetical on past volume, not a forecast — volume itself may move once the rate does.
   */
  windowCommissionAtRequested: number;
  /** Negative = the platform gives this up per window. */
  windowImpact: number;
}

/** The rate in force on a product: its own override, else the seller's default. */
export async function effectiveCommissionPct(productId: string): Promise<{ pct: number; sellerId: string | null; productName: string }> {
  const product = await prisma.catalogProduct.findUnique({
    where: { id: productId },
    select: {
      id: true, name: true, sellerId: true, commissionPctOverride: true,
      seller: { select: { id: true, commissionPct: true } },
    },
  });
  if (!product) throw new NotFoundError("Product", productId);
  // ⚠️ Same helper the money math uses, so the number the seller is shown and the number they are
  // charged can never be two different readings of the same columns.
  const pct = resolveCommissionPct(
    { lineTotal: 0, taxableValue: 0, commissionPctOverride: product.commissionPctOverride == null ? null : n(product.commissionPctOverride) },
    n(product.seller?.commissionPct),
  );
  return { pct, sellerId: product.sellerId, productName: product.name };
}

/**
 * A seller asks for a rate on one of their own products.
 *
 * ⚠️ Refuses a second PENDING request on the same product. Two open asks on one product means the
 * owner's decision depends on which they happen to click, and the loser silently becomes a rate
 * nobody granted.
 */
export async function createCommissionRequest(opts: {
  sellerId: string;
  productId: string;
  requestedPct: number;
  sellerNote?: string | null;
}): Promise<CommissionRequestView> {
  const { sellerId, productId, requestedPct } = opts;
  if (!Number.isFinite(requestedPct) || requestedPct < 0 || requestedPct > 100) {
    throw new ValidationError("A commission rate must be between 0 and 100.");
  }

  const product = await prisma.catalogProduct.findUnique({
    where: { id: productId },
    select: { id: true, name: true, sellerId: true, commissionPctOverride: true },
  });
  if (!product) throw new NotFoundError("Product", productId);
  // Scoped, not trusted. A seller may only negotiate their own listing.
  if (product.sellerId !== sellerId) throw new NotFoundError("Product", productId);

  const open = await prisma.commissionRequest.findFirst({
    where: { productId, sellerId, status: "PENDING" },
    select: { id: true },
  });
  if (open) throw new ValidationError("You already have a request open on this product. Withdraw it first.");

  const { pct: currentPct } = await effectiveCommissionPct(productId);
  if (r2(currentPct) === r2(requestedPct)) {
    throw new ValidationError(`This product is already at ${r2(requestedPct)}%.`);
  }

  const row = await prisma.commissionRequest.create({
    data: {
      sellerId,
      productId,
      // Snapshotted. Without it the owner's queue could only show the rate as it is NOW, so a
      // request made against 5% would still read "5% → 2%" after the default moved to 4% — and the
      // owner would approve something they never saw.
      currentPct,
      requestedPct,
      sellerNote: opts.sellerNote?.trim() || null,
    },
    select: { id: true },
  });
  const view = await getRequestView(row.id);
  return view;
}

/** Seller withdraws their own open request. */
export async function withdrawCommissionRequest(sellerId: string, id: string): Promise<void> {
  const claimed = await prisma.commissionRequest.updateMany({
    where: { id, sellerId, status: "PENDING" },
    data: { status: "WITHDRAWN", decidedAt: new Date() },
  });
  if (claimed.count === 0) throw new ValidationError("That request is not open, or is not yours.");
}

export type DecisionAction = "APPROVE" | "COUNTER" | "REJECT";
export type DecisionStatus = "APPROVED" | "COUNTERED" | "REJECTED";

/**
 * What a decision actually grants — pulled out of the database path because this is the one step
 * where a mistake writes a WRONG RATE onto a product and nothing on any screen says so.
 *
 * ⚠️ REJECT grants null, not 0. Null leaves the product on the seller default; 0 would silently put
 * it on zero commission — the platform working that product for free, written by the code path
 * whose whole purpose was to decline.
 */
export function resolveDecision(
  action: DecisionAction,
  requestedPct: number,
  approvedPct: number | null,
): { status: DecisionStatus; granted: number | null } {
  if (action === "REJECT") return { status: "REJECTED", granted: null };
  if (action === "APPROVE") return { status: "APPROVED", granted: r2(requestedPct) };

  if (approvedPct == null) throw new ValidationError("A counter needs the rate you are offering.");
  const granted = Number(approvedPct);
  if (!Number.isFinite(granted) || granted < 0 || granted > 100) {
    throw new ValidationError("A commission rate must be between 0 and 100.");
  }
  if (r2(granted) === r2(requestedPct)) {
    throw new ValidationError("That is the rate they asked for — approve it instead of countering.");
  }
  return { status: "COUNTERED", granted: r2(granted) };
}

/**
 * The owner decides.
 *
 * APPROVE  → grant exactly what was asked.
 * COUNTER  → grant a different rate. `approvedPct` is required and is what lands on the product.
 * REJECT   → nothing is written to the product.
 *
 * ⚠️ The override write and the status stamp happen in ONE transaction. Splitting them leaves the
 * two states that matter: a product charging a rate with no record of who granted it, or a record of
 * a decision the money math never heard about.
 */
export async function decideCommissionRequest(opts: {
  id: string;
  action: DecisionAction;
  approvedPct?: number | null;
  ownerNote?: string | null;
  decidedByUserId?: string | null;
}): Promise<CommissionRequestView> {
  const { id, action } = opts;
  const req = await prisma.commissionRequest.findUnique({
    where: { id },
    select: { id: true, status: true, productId: true, requestedPct: true },
  });
  if (!req) throw new NotFoundError("Commission request", id);
  if (req.status !== "PENDING") throw new ValidationError(`That request is already ${req.status.toLowerCase()}.`);

  const { status, granted } = resolveDecision(action, n(req.requestedPct), opts.approvedPct ?? null);

  await prisma.$transaction(async (tx) => {
    // Compare-and-swap on PENDING: two owners deciding the same request at once must not both write
    // a rate, and the loser must not overwrite the winner's.
    const claimed = await tx.commissionRequest.updateMany({
      where: { id, status: "PENDING" },
      data: {
        status,
        approvedPct: granted,
        ownerNote: opts.ownerNote?.trim() || null,
        decidedAt: new Date(),
        decidedByUserId: opts.decidedByUserId ?? null,
      },
    });
    if (claimed.count === 0) throw new ValidationError("That request was just decided by someone else.");

    if (granted != null) {
      await tx.catalogProduct.update({
        where: { id: req.productId },
        data: { commissionPctOverride: granted },
        select: { id: true },
      });
    }
  });

  return getRequestView(id);
}

/** One request, with the volume and impact figures the owner needs to size it. */
export async function getRequestView(id: string): Promise<CommissionRequestView> {
  const rows = await buildViews({ id });
  const view = rows[0];
  if (!view) throw new NotFoundError("Commission request", id);
  return view;
}

export async function listCommissionRequests(filter: {
  sellerId?: string;
  status?: string;
}): Promise<CommissionRequestView[]> {
  return buildViews(filter);
}

async function buildViews(filter: { id?: string; sellerId?: string; status?: string }): Promise<CommissionRequestView[]> {
  const requests = await prisma.commissionRequest.findMany({
    where: {
      ...(filter.id ? { id: filter.id } : {}),
      ...(filter.sellerId ? { sellerId: filter.sellerId } : {}),
      ...(filter.status ? { status: filter.status as never } : {}),
    },
    // PENDING first and oldest first inside it: a queue that buries the longest-waiting ask under
    // whatever was decided most recently is a queue nobody works through.
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    select: {
      id: true, productId: true, sellerId: true, currentPct: true, requestedPct: true,
      approvedPct: true, sellerNote: true, ownerNote: true, status: true, createdAt: true,
      decidedAt: true,
      seller: { select: { name: true, commissionPct: true } },
      product: { select: { name: true, commissionPctOverride: true } },
    },
  });
  if (requests.length === 0) return [];

  // 30-day volume, per product, from the lines themselves.
  //
  // ⚠️ Summed on OrderItem.taxableValue because that is the base commission is charged on since
  // step 07. Sizing a rate change against the GST-inclusive figure would overstate what the platform
  // is giving up on every taxed product.
  const since = new Date(Date.now() - IMPACT_WINDOW_DAYS * 86400000);
  const productIds = [...new Set(requests.map((r) => r.productId))];
  const volume = await prisma.orderItem.groupBy({
    by: ["variantId"],
    where: {
      variant: { is: { productId: { in: productIds } } },
      order: { is: { status: { not: "CANCELLED" }, createdAt: { gte: since } } },
    },
    _sum: { taxableValue: true, commissionAmount: true },
    _count: true,
  });
  // variantId → productId, so per-variant sums roll up to the product the rate applies to.
  const variants = await prisma.productVariant.findMany({
    where: { productId: { in: productIds } },
    select: { id: true, productId: true },
  });
  const productOfVariant = new Map(variants.map((v) => [v.id, v.productId]));
  const byProduct = new Map<string, { taxable: number; commission: number; count: number }>();
  for (const v of volume) {
    const pid = v.variantId ? productOfVariant.get(v.variantId) : undefined;
    if (!pid) continue;
    const a = byProduct.get(pid) ?? { taxable: 0, commission: 0, count: 0 };
    a.taxable = r2(a.taxable + n(v._sum.taxableValue));
    a.commission = r2(a.commission + n(v._sum.commissionAmount));
    a.count += v._count;
    byProduct.set(pid, a);
  }

  return requests.map((r) => {
    const vol = byProduct.get(r.productId) ?? { taxable: 0, commission: 0, count: 0 };
    const effectiveNow = r.product.commissionPctOverride == null
      ? n(r.seller.commissionPct)
      : n(r.product.commissionPctOverride);
    // ⚠️ Priced at the rate in force NOW, not at the snapshot, because that is what the owner would
    // stop earning from today. The snapshot is what the seller was looking at when they asked.
    const atCurrent = r2((vol.taxable * effectiveNow) / 100);
    const atRequested = r2((vol.taxable * n(r.requestedPct)) / 100);
    return {
      id: r.id,
      productId: r.productId,
      productName: r.product.name,
      sellerId: r.sellerId,
      sellerName: r.seller.name,
      currentPct: n(r.currentPct),
      requestedPct: n(r.requestedPct),
      approvedPct: r.approvedPct == null ? null : n(r.approvedPct),
      effectivePctNow: effectiveNow,
      sellerNote: r.sellerNote,
      ownerNote: r.ownerNote,
      status: r.status,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      windowTaxable: vol.taxable,
      windowOrderCount: vol.count,
      // What was ACTUALLY charged over the window, where the lines carry it. Falls back to the rate
      // in force when they do not — every line placed before step 08 has no per-line amount.
      windowCommission: vol.commission > 0 ? vol.commission : atCurrent,
      windowCommissionAtRequested: atRequested,
      windowImpact: r2(atRequested - (vol.commission > 0 ? vol.commission : atCurrent)),
    };
  });
}
