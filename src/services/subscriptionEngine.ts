import prisma from "../lib/prisma.js";
import type { Prisma } from "@prisma/client";
import { pickSubstitute, shouldAlertPriceChange } from "./routineIntel.js";
import { getNextOrderNumber } from "./orderNumbering.js";
import { planRoutineRun, round2, type RoutineItemRow } from "./routinePlan.js";
import {
  notifyNewOrder,
  notifyRoutineHeld,
  notifyRoutineItemsSkipped,
  notifyRoutineSubstituted,
  notifyRoutinePriceUp,
  notifySubscriptionSkipped,
  notifySubscriptionLowBalance,
  notifySubscriptionStatement,
  notifySubscriptionEndingSoon,
} from "./fcmNotifier.js";
import { generateOrderInvoice, generateStatementInvoice, markStatementInvoicePaid } from "./orderInvoice.js";
import { chargeSubscriptionMandate } from "./razorpay.js";
import { consumeFifo, recordConsumption, type ConsumeResult } from "./stockBatches.js";
import { AppError } from "../lib/errors.js";
import { computeSubOrderTds194o } from "./sellerTds194o.js";
import { sumSellerLines, computeSellerSplit } from "./sellerSplit.js";
import { houseSellerIsSeparateEntity, isSameLegalEntity } from "./entitySplit.js";
import { TCS_RATE_PCT } from "../data/taxRates.js";

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions engine (milk / newspaper / recurring deliveries).
//
// Three responsibilities:
//   1. Pricing a routine delivery — FREE delivery, no coupon/loyalty/wallet/bulk (routinePlan.ts
//      priceSubscriptionDelivery). This deliberately does NOT call calculateCartTotals, which would
//      force a per-order delivery charge (cartPricing.ts:182-188) and apply discounts we don't want per
//      delivery. Bug-isolation over DRY.
//   2. Turning due routines (a Subscription + its SubscriptionItems) into ONE real Order per run
//      (status=PACKED, one OrderItem per available line) that flows through the existing delivery
//      pipeline. Mirrors the order-placement transaction (routes/orders.ts), stripped to a deferred order.
//   3. Closing one consolidated monthly statement per customer per tender, settled by wallet/COD.
//
// All dates use IST-midnight semantics (reuses the IST pattern from routes/delivery.ts).
// ─────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_DAY = 24 * 60 * 60 * 1000;

// Pricing + planning live in routinePlan.ts (pure, no DB). Re-exported so existing importers keep working.
export { priceSubscriptionDelivery, type SubscriptionPricing } from "./routinePlan.js";

// Sentinel: an out-of-stock day. Thrown inside the generation transaction to roll it back, then
// caught and turned into a "skip + notify" — never a real error (one bad SKU must not stall the sweep).
class OosSkip extends Error {}

// Sentinel: a prepaid-wallet delivery that couldn't be funded (balance too low). Thrown inside the txn
// so the stock decrement + order rolls back — we never deliver unpaid. Caught → skip + "top up" notify.
class WalletSkip extends Error {}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

// ─── IST date helpers ────────────────────────────────────────────────────────

/** The UTC instant of IST-midnight of the IST calendar day that `d` falls on. */
export function istMidnight(d: Date): Date {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const midnightUtcMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return new Date(midnightUtcMs - IST_OFFSET_MS);
}

export function istTodayStart(): Date {
  return istMidnight(new Date());
}

/** IST weekday (0=Sun..6=Sat) of an IST-midnight-in-UTC date. */
function istWeekday(istMid: Date): number {
  return new Date(istMid.getTime() + IST_OFFSET_MS).getUTCDay();
}

/** IST day-of-month (1..31) of an IST-midnight-in-UTC date. */
function istDayOfMonth(istMid: Date): number {
  return new Date(istMid.getTime() + IST_OFFSET_MS).getUTCDate();
}

// ─── Cadence math (pure — unit-tested) ───────────────────────────────────────

export interface CadenceLike {
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "CUSTOM";
  intervalDays: number | null;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  startDate: Date;
  endDate?: Date | null;
}

/** Is `dayIST` (IST-midnight-in-UTC) a genuine delivery day for this cadence? */
export function isValidDeliveryDay(sub: CadenceLike, dayIST: Date): boolean {
  switch (sub.frequency) {
    case "DAILY":
      return true;
    case "WEEKLY":
      return sub.daysOfWeek.includes(istWeekday(dayIST));
    case "MONTHLY":
      return istDayOfMonth(dayIST) === sub.dayOfMonth;
    case "CUSTOM": {
      const n = sub.intervalDays && sub.intervalDays > 0 ? sub.intervalDays : 1;
      const start = istMidnight(sub.startDate);
      const diffDays = Math.round((dayIST.getTime() - start.getTime()) / MS_DAY);
      return diffDays >= 0 && diffDays % n === 0;
    }
    default:
      return false;
  }
}

/** The next valid delivery day STRICTLY AFTER `fromDayIST`. */
export function computeNextDeliveryDate(sub: CadenceLike, fromDayIST: Date): Date {
  let cursor = istMidnight(fromDayIST);
  for (let i = 0; i < 400; i++) {
    cursor = istMidnight(new Date(cursor.getTime() + MS_DAY));
    if (sub.endDate && cursor > istMidnight(sub.endDate)) return cursor;
    if (isValidDeliveryDay(sub, cursor)) return cursor;
  }
  return cursor; // unreachable for sane configs
}

/** The first valid delivery day ON OR AFTER `fromDate` (used to seed nextDeliveryDate at create). */
export function firstDeliveryOnOrAfter(sub: CadenceLike, fromDate: Date): Date {
  const day0 = istMidnight(fromDate);
  if (isValidDeliveryDay(sub, day0)) return day0;
  return computeNextDeliveryDate(sub, day0);
}

/** The next `count` valid delivery dates from today forward (for the "upcoming" view). */
export function upcomingDates(
  sub: CadenceLike & { nextDeliveryDate?: Date | null },
  count = 10,
): Date[] {
  const today = istTodayStart();
  let start = sub.nextDeliveryDate ? istMidnight(sub.nextDeliveryDate) : today;
  if (start < today) start = today;
  const out: Date[] = [];
  let dayCursor = new Date(start.getTime() - MS_DAY); // first +1 lands on `start`
  for (let i = 0; i < 400 && out.length < count; i++) {
    dayCursor = istMidnight(new Date(dayCursor.getTime() + MS_DAY));
    if (sub.endDate && dayCursor > istMidnight(sub.endDate)) break;
    if (isValidDeliveryDay(sub, dayCursor)) out.push(dayCursor);
  }
  return out;
}

export interface SubscriptionPlanRow {
  variantId: string;
  productName: string;
  unit: string;
  isLoose: boolean;
  totalQty: number;
  customerCount: number;
  /** Base-unit demand for the day (loose: qty × step size) — comparable to `stock`. */
  neededBase: number;
  /** Variant stock right now, base units. */
  stock: number;
  /** max(0, neededBase − stock): how much to restock before the run. */
  shortBy: number;
  /** Quantity per delivery window — "how much is for 7–9 AM".
   *  Keyed by slot id; app units, same as totalQty. */
  bySlot: Record<string, number>;
}

/**
 * Per-variant planning totals for a target delivery day — "Tomorrow: 40× Milk 500ml, 12× Newspaper" —
 * how many of each to stock/pack. Optionally scoped to one seller's own products (via
 * variant.product.sellerId) so a seller sees only their own subscribers, not the whole store's. Shared
 * by the owner's and seller's `/upcoming` routes (was duplicated inline in ownerSubscriptions.ts).
 *
 * Routines contribute one row-increment PER ITEM. Rows with no SubscriptionItem (pre-migration /
 * rolling-deploy overlap) fall back to their legacy single-product columns, same as the engine.
 *
 * `sellerIsHouse` matters because `CatalogProduct.sellerId` is nullable and — per the schema's own
 * comment — "a null seller is treated as the house seller everywhere": products created via the owner's
 * classic editor (ownerCatalog.ts) never set sellerId, but products created via the co-manager's
 * seller-scoped editor (sellerCatalog.ts) do. Both are equally "house" products. Without this, the house
 * co-manager would only see subscriptions on the SECOND group and silently under-count the first.
 */
export async function computeUpcomingPlan(
  target: Date,
  sellerId?: string,
  sellerIsHouse?: boolean,
): Promise<SubscriptionPlanRow[]> {
  const now = new Date();
  const productFilter = sellerId
    ? sellerIsHouse
      ? { OR: [{ sellerId }, { sellerId: null }] }
      : { sellerId }
    : undefined;
  const subs = await prisma.subscription.findMany({
    where: {
      status: "ACTIVE",
      startDate: { lte: target },
      OR: [{ pausedUntil: null }, { pausedUntil: { lte: now } }],
      AND: [{ OR: [{ endDate: null }, { endDate: { gte: target } }] }],
    },
    include: {
      items: { include: { variant: { select: { stock: true, product: { select: { sellerId: true } } } } } },
      variant: { select: { stock: true, product: { select: { sellerId: true } } } },
    },
  });

  const inScope = (itemSellerId: string | null | undefined): boolean => {
    if (!productFilter) return true;
    if (sellerIsHouse) return itemSellerId == null || itemSellerId === sellerId;
    return itemSellerId === sellerId;
  };

  const byVariant = new Map<string, SubscriptionPlanRow>();
  for (const sub of subs) {
    if (!isValidDeliveryDay(sub as unknown as CadenceLike, target)) continue;
    const lines =
      sub.items.length > 0
        ? sub.items.map((i) => ({
            variantId: i.variantId,
            productName: i.productName,
            unit: i.stepUnit ?? "",
            isLoose: i.isLoose,
            qty: Number(i.quantity),
            step: i.stepSize == null ? 1 : Number(i.stepSize),
            stock: Number(i.variant?.stock ?? 0),
            sellerId: i.variant?.product?.sellerId,
          }))
        : sub.variantId && sub.quantity != null
          ? [{
              variantId: sub.variantId,
              productName: sub.productName,
              unit: sub.stepUnit ?? "",
              isLoose: sub.isLoose,
              qty: Number(sub.quantity),
              step: sub.stepSize == null ? 1 : Number(sub.stepSize),
              stock: Number(sub.variant?.stock ?? 0),
              sellerId: sub.variant?.product?.sellerId,
            }]
          : [];
    for (const l of lines) {
      if (!inScope(l.sellerId)) continue;
      const row = byVariant.get(l.variantId) ?? {
        variantId: l.variantId,
        productName: l.productName,
        unit: l.unit,
        isLoose: l.isLoose,
        totalQty: 0,
        customerCount: 0,
        neededBase: 0,
        stock: l.stock,
        shortBy: 0,
        bySlot: {},
      };
      row.totalQty = +(row.totalQty + l.qty).toFixed(3);
      row.customerCount += 1;
      // Loose quantities are counts of steps; stock is in base units, so compare like with like.
      row.neededBase = +(row.neededBase + (l.isLoose ? l.qty * l.step : l.qty)).toFixed(3);
      row.bySlot[sub.deliverySlotId] = +((row.bySlot[sub.deliverySlotId] ?? 0) + l.qty).toFixed(3);
      byVariant.set(l.variantId, row);
    }
  }
  for (const row of byVariant.values()) row.shortBy = +Math.max(0, row.neededBase - row.stock).toFixed(3);
  // Biggest shortfall first (that is what the owner has to act on), then biggest demand.
  return [...byVariant.values()].sort((a, b) => b.shortBy - a.shortBy || b.totalQty - a.totalQty);
}

// ─── Routine rows ─────────────────────────────────────────────────────────────

/** The slice of a Subscription row the generator reads. `items` may be absent on legacy rows. */
export interface RoutineRow {
  id: string;
  customerId: string;
  name: string | null;
  productName: string;
  imageUrl: string | null;
  addressId: string | null;
  billing: string; // "WALLET" | "COD" | "AUTOPAY"
  mandateId: string | null;
  priceCeilingType: "ABSOLUTE" | "PERCENT";
  priceCeilingValue: unknown;
  /** Run total at the last "prices went up" push (null = none outstanding). */
  lastAlertedTotal?: unknown;
  items?: { id: string; variantId: string; productName: string; imageUrl: string | null; quantity: unknown; unitPriceSnapshot: unknown; substitution?: string }[];
  // LEGACY single-product columns — only read when `items` is empty (see resolveRoutineItems).
  variantId?: string | null;
  quantity?: unknown;
  isLoose?: boolean;
  unitPriceSnapshot?: unknown;
}

export function routineTitle(sub: Pick<RoutineRow, "name" | "productName">): string {
  return sub.name ?? sub.productName;
}

/**
 * The lines a routine delivers: its SubscriptionItems, or — for a row that has none (a subscription
 * created by an old app build during a rolling deploy, or never backfilled) — its legacy single-product
 * columns as one line. This fallback is what keeps old single-product subscriptions delivering.
 */
export function resolveRoutineItems(sub: RoutineRow): RoutineItemRow[] {
  if (sub.items && sub.items.length > 0) {
    return sub.items.map((i) => ({
      id: i.id,
      variantId: i.variantId,
      productName: i.productName,
      imageUrl: i.imageUrl,
      quantity: Number(i.quantity),
      unitPriceSnapshot: i.unitPriceSnapshot == null ? null : Number(i.unitPriceSnapshot),
      substitution: i.substitution === "SIMILAR" ? "SIMILAR" : "SKIP",
    }));
  }
  if (sub.variantId && sub.quantity != null) {
    return [{
      id: `legacy:${sub.id}`,
      variantId: sub.variantId,
      productName: sub.productName,
      imageUrl: sub.imageUrl,
      quantity: Number(sub.quantity),
      // The legacy snapshot of a loose product was per-base-unit, not app format → no usable baseline.
      unitPriceSnapshot: sub.isLoose || sub.unitPriceSnapshot == null ? null : Number(sub.unitPriceSnapshot),
    }];
  }
  return [];
}

// ─── Generation (ONE Order per due routine per day) ───────────────────────────

export type GenerateResult =
  | "generated"
  | "skipped_oos"
  | "skipped_lowbalance"
  | "skipped_date"
  | "held"
  | "duplicate";

const VARIANT_PRODUCT_SELECT = {
  id: true,
  name: true,
  productType: true,
  hsnCode: true,
  gstRate: true,
  isPackaged: true,
  categoryId: true,
  imageUrls: true,
  sellerId: true,
  commissionPctOverride: true,
} as const;

type VariantRow = Awaited<ReturnType<typeof loadVariantRows>>[number];

function loadVariantRows(where: Prisma.ProductVariantWhereInput, take?: number) {
  return prisma.productVariant.findMany({
    where,
    include: { product: { select: VARIANT_PRODUCT_SELECT } },
    ...(take ? { take } : {}),
  });
}

/**
 * For items whose rule is SIMILAR and which can't ship today (inactive, or not enough stock), swap in the
 * closest-priced in-stock product of the SAME category and store (see routineIntel.pickSubstitute). The
 * swapped line keeps the original item's id and price baseline, so the price ceiling still compares the
 * stand-in against what the customer normally pays. No suitable stand-in → the item is left as is and the
 * plan skips it. Mutates `variants` to include the stand-ins.
 */
async function applySubstitutions(
  items: RoutineItemRow[],
  variants: Map<string, VariantRow>,
): Promise<{ items: RoutineItemRow[]; substituted: { itemId: string; from: string; to: string }[] }> {
  const substituted: { itemId: string; from: string; to: string }[] = [];
  const taken = new Set(items.map((i) => i.variantId));
  const out: RoutineItemRow[] = [];
  for (const item of items) {
    const original = variants.get(item.variantId);
    if (item.substitution !== "SIMILAR" || !original) {
      out.push(item);
      continue;
    }
    const loose = original.product.productType === "LOOSE" || original.product.productType === "PRODUCE";
    const needed = loose ? item.quantity * Number(original.packageSize) : item.quantity;
    if (original.isActive && Number(original.stock) + 1e-9 >= needed) {
      out.push(item);
      continue;
    }
    const candidates = await loadVariantRows(
      {
        isActive: true,
        id: { notIn: [...taken] },
        stock: { gt: 0 },
        product: {
          categoryId: original.product.categoryId,
          sellerId: original.product.sellerId,
          isActive: true,
          deletedAt: null,
          approvalStatus: "APPROVED",
        },
      },
      30,
    );
    const pick = pickSubstitute(original, item.quantity, candidates);
    if (!pick) {
      out.push(item);
      continue;
    }
    variants.set(pick.id, pick);
    taken.add(pick.id);
    out.push({ ...item, variantId: pick.id, productName: pick.product.name, imageUrl: pick.product.imageUrls?.[0] ?? item.imageUrl });
    substituted.push({ itemId: item.id, from: item.productName, to: pick.product.name });
  }
  return { items: out, substituted };
}

/**
 * Generate today's order for a routine: refresh inventory + prices, plan the basket, and either
 *   • place ONE Order carrying one OrderItem per available line (price within the ceiling), or
 *   • HOLD the run and ask the customer to review (price above the ceiling), or
 *   • skip (everything unavailable / wallet short / customer skipped the date).
 * Unavailable lines are dropped and reported; the rest of the basket still goes. Idempotent per
 * (routine, day) via Order's @@unique([subscriptionId, subscriptionDate]).
 *
 * `opts.ignoreCeiling` is the customer's "approve" on a held run (also set when the day's exception row is
 * APPROVED). An approved run re-baselines the item snapshots, so a lasting price rise isn't held forever.
 */
export async function generateRoutineOrder(
  sub: RoutineRow,
  dayIST: Date,
  defaultAgentId: string | null,
  opts: { ignoreCeiling?: boolean } = {},
): Promise<GenerateResult> {
  const title = routineTitle(sub);

  // Calendar skip / held-run state for this date.
  const exception = await prisma.subscriptionException.findUnique({
    where: { subscriptionId_date: { subscriptionId: sub.id, date: dayIST } },
  });
  if (exception && exception.type === "SKIP") return "skipped_date";
  const approved = opts.ignoreCeiling === true || exception?.type === "APPROVED";
  if (exception?.type === "HELD" && !approved) return "held"; // already held + notified; waiting on the customer

  const baseItems = resolveRoutineItems(sub);
  const variantRows = baseItems.length
    ? await loadVariantRows({ id: { in: baseItems.map((i) => i.variantId) } })
    : [];
  const variants = new Map(variantRows.map((v) => [v.id, v]));
  // Items set to "use a similar one" that can't ship today are swapped for an in-stock stand-in.
  const { items, substituted } = await applySubstitutions(baseItems, variants);
  const substitutedIds = new Set(substituted.map((s) => s.itemId));

  const plan = planRoutineRun(items, variants, {
    type: sub.priceCeilingType,
    value: Number(sub.priceCeilingValue),
  });

  // Nothing deliverable (every line out of stock / inactive) → skip the day, tell the customer.
  if (plan.lines.length === 0) {
    await notifySubscriptionSkipped(sub.customerId, title).catch((e: unknown) => console.error("[background task failed]", e));
    return "skipped_oos";
  }

  // Price drift above the ceiling → hold this run; the customer reviews (approve → order placed at today's price).
  if (!approved && !plan.withinCeiling) {
    await prisma.subscriptionException.upsert({
      where: { subscriptionId_date: { subscriptionId: sub.id, date: dayIST } },
      create: { subscriptionId: sub.id, date: dayIST, type: "HELD" },
      update: {},
    });
    await notifyRoutineHeld(sub.customerId, title, sub.id, plan.totalAmount, plan.estimate).catch((e: unknown) => console.error("[background task failed]", e));
    return "held";
  }

  const [address, customer, houseSeller, orderNumber] = await Promise.all([
    sub.addressId ? prisma.address.findUnique({ where: { id: sub.addressId } }) : Promise.resolve(null),
    prisma.user.findUnique({ where: { id: sub.customerId }, select: { name: true, phone: true } }),
    prisma.seller.findFirst({ where: { isHouse: true }, select: { id: true } }),
    getNextOrderNumber(),
  ]);

  // ── Resolve the payment tender BEFORE the txn (prepaid-first — never postpaid). ──
  const total = plan.totalAmount;
  let paymentMethod: "WALLET" | "COD" | "UPI";
  let paymentStatus: "PAID" | "PENDING";
  if (sub.billing === "COD") {
    // Pay-on-delivery daily cash: agent collects at the stop; deliver flips COD→PAID.
    paymentMethod = "COD";
    paymentStatus = "PENDING";
  } else if (sub.billing === "AUTOPAY") {
    // UPI mandate charge (inert until a live Razorpay merchant + mandate exist → skip + notify).
    const charged = sub.mandateId ? await chargeSubscriptionMandate(sub.mandateId, total) : null;
    if (!charged) {
      await notifySubscriptionLowBalance(sub.customerId, title).catch((e: unknown) => console.error("[background task failed]", e));
      return "skipped_lowbalance";
    }
    paymentMethod = "UPI";
    paymentStatus = "PAID";
  } else {
    // WALLET (default): auto-debited inside the txn (guarded) — insufficient → WalletSkip.
    paymentMethod = "WALLET";
    paymentStatus = "PAID";
  }
  const walletFunded = paymentMethod === "WALLET";

  // Each line's seller (null seller == house). One routine is one store, but group anyway so a seller
  // change after creation still splits correctly instead of mis-attributing a payout.
  const sellerOf = (l: (typeof plan.lines)[number]) => l.variant.product.sellerId ?? houseSeller?.id ?? null;

  let createdOrder: { id: string; orderNumber: string; totalAmount: unknown; customerId: string } | null = null;

  try {
    createdOrder = await prisma.$transaction(async (tx) => {
      // FIFO-consume every line's base-units (mirrors routes/orders.ts's consumeFifo call). A shortfall
      // here is a race lost AFTER the plan's stock check — roll the whole run back (OosSkip) rather than
      // ship a basket that no longer matches what was priced/charged.
      const consumed = new Map<string, ConsumeResult>();
      for (const l of plan.lines) {
        try {
          consumed.set(l.variant.id, await consumeFifo(tx, l.variant.id, l.needed));
        } catch (e) {
          if (e instanceof AppError && e.code === "INSUFFICIENT_STOCK") throw new OosSkip();
          throw e;
        }
      }

      const created = await tx.order.create({
        data: {
          orderNumber,
          customerId: sub.customerId,
          status: "PACKED", // lands straight in the delivery route (D7)
          fulfillmentType: "DELIVERY",
          paymentMethod, // WALLET (prepaid) / COD (daily cash) / UPI (autopay)
          paymentStatus, // PAID for prepaid tenders, PENDING for COD-on-delivery
          addressId: address?.id,
          shippingName: customer?.name,
          shippingPhone: customer?.phone,
          shippingAddress: address?.addressLine,
          shippingPincode: address?.pincode,
          subtotal: plan.subtotal,
          discount: 0,
          deliveryCharge: 0, // 🩹 routine deliveries are free (D4)
          // Step 15: zero, and that is the honest answer rather than a NULL. A routine drop is
          // never charged for separately, so delivery is bundled into the price of the goods — a
          // composite supply with no separate delivery supply to value. "Split, came to nothing",
          // not "never split".
          deliveryTaxable: 0,
          deliveryGst: 0,
          taxableValue: plan.taxableValue,
          totalTax: plan.totalTax,
          totalAmount: plan.totalAmount,
          savedAmount: plan.savedAmount,
          walletApplied: walletFunded ? total : 0,
          deliveryOtpRequired: false,
          deliveryBoyId: defaultAgentId,
          subscriptionId: sub.id,
          subscriptionDate: dayIST, // idempotency key with @@unique([subscriptionId, subscriptionDate])
          items: {
            create: plan.lines.map((l) => ({
              variantId: l.variant.id,
              productName: l.variant.product.name,
              variantSku: l.variant.sku,
              imageUrl: l.variant.product.imageUrls?.[0] ?? l.item.imageUrl ?? null,
              hsnCode: l.variant.product.hsnCode,
              unitPrice: l.pricing.unitPrice,
              mrp: l.pricing.mrp,
              quantity: l.item.quantity as never,
              gstRate: l.pricing.gstRate,
              taxableValue: l.pricing.taxableValue,
              cgst: l.pricing.cgst,
              sgst: l.pricing.sgst,
              lineTotal: l.pricing.lineTotal,
              isLoose: l.isLoose,
              stepSize: l.isLoose ? Number(l.variant.packageSize) : null,
              stepUnit: l.isLoose ? l.variant.packageUnit : null,
              packageUnit: l.variant.packageUnit,
              sellerId: sellerOf(l),
              costPriceSnapshot: consumed.get(l.variant.id)!.totalQty > 0 ? consumed.get(l.variant.id)!.weightedUnitCost : null,
            })),
          },
        },
        select: { id: true, orderNumber: true, totalAmount: true, customerId: true, items: { select: { id: true, variantId: true } } },
      });

      // Link each batch draw to the OrderItem it fed. One line per variant per routine (unique), so the
      // variantId → item lookup is unambiguous.
      const itemIdByVariant = new Map(created.items.map((i) => [i.variantId, i.id]));
      for (const l of plan.lines) {
        await recordConsumption(tx, { orderItemId: itemIdByVariant.get(l.variant.id)! }, consumed.get(l.variant.id)!.consumed);
      }

      // Prepaid-wallet: ONE guarded debit for the whole basket + ledger row, atomic with the order.
      // Insufficient balance → WalletSkip rolls back the stock draws + order (we never deliver unpaid).
      // @@unique([orderId, type]) keeps the debit idempotent (one order per routine-day).
      if (walletFunded) {
        const wdec = await tx.user.updateMany({
          where: { id: sub.customerId, walletBalance: { gte: total } },
          data: { walletBalance: { decrement: total } },
        });
        if (wdec.count === 0) throw new WalletSkip();
        const fresh = await tx.user.findUnique({
          where: { id: sub.customerId },
          select: { walletBalance: true },
        });
        await tx.walletTransaction.create({
          data: {
            userId: sub.customerId,
            amount: -total,
            type: "ORDER_DEBIT",
            balanceAfter: fresh!.walletBalance,
            orderId: created.id,
            note: `Routine: ${title}`,
          },
        });
      }

      // One SubOrder per seller group — mirrors routes/orders.ts:294-354 simplified. House seller →
      // commission 0, TCS 0, no payout accrual. Keeps the delivery feed + invoices consistent.
      const bySeller = new Map<string, typeof plan.lines>();
      for (const l of plan.lines) {
        const sid = sellerOf(l);
        if (!sid) continue;
        bySeller.set(sid, [...(bySeller.get(sid) ?? []), l]);
      }
      for (const [sellerId, group] of bySeller) {
        const seller = await tx.seller.findUnique({
          where: { id: sellerId },
          select: { id: true, commissionPct: true, isHouse: true, pan: true, entityType: true },
        });
        if (!seller) continue;
        const houseIsSeparate = await houseSellerIsSeparateEntity(tx);
        const taxable = round2(group.reduce((s, l) => s + l.pricing.taxableValue, 0));
        // Sec 194-O TDS — same discipline as routes/orders.ts. Off (0) unless StoreConfig.tds194oEnabled.
        const { tdsAmount } = await computeSubOrderTds194o(tx, seller, taxable);
        // Routed through sumSellerLines so the per-product override and the rounding come from the same
        // place as every other order (step 08).
        const lineTotals = sumSellerLines(
          group.map((l) => ({
            lineTotal: l.pricing.lineTotal,
            taxableValue: l.pricing.taxableValue,
            commissionPctOverride: l.variant.product.commissionPctOverride == null
              ? null
              : Number(l.variant.product.commissionPctOverride),
          })),
          Number(seller.commissionPct),
        );
        const split = computeSellerSplit({
          subtotal: lineTotals.subtotal,
          taxableValue: lineTotals.taxableValue,
          commissionPct: lineTotals.commissionPct,
          commissionAmount: lineTotals.commissionAmount,
          commissionGstAmount: lineTotals.commissionGstAmount,
          tcsRatePct: TCS_RATE_PCT,
          tdsAmount,
          isHouse: isSameLegalEntity(seller, houseIsSeparate), // step 09 - see services/entitySplit.ts
        });
        const subOrder = await tx.subOrder.create({
          data: { orderId: created.id, sellerId, status: "PACKED", ...split },
        });
        for (let i = 0; i < group.length; i++) {
          await tx.orderItem.update({
            where: { id: itemIdByVariant.get(group[i]!.variant.id)! },
            data: {
              subOrderId: subOrder.id,
              commissionPct: lineTotals.lineCommissions[i]!.commissionPct,
              commissionAmount: lineTotals.lineCommissions[i]!.commissionAmount,
            },
          });
        }
        if (!isSameLegalEntity(seller, houseIsSeparate)) {
          await tx.seller.update({
            where: { id: sellerId },
            data: { outstandingBalance: { increment: split.netPayable } },
            select: { id: true },
          });
        }
      }

      return created;
    });
  } catch (e) {
    if (e instanceof OosSkip) {
      await notifySubscriptionSkipped(sub.customerId, title).catch((e: unknown) => console.error("[background task failed]", e));
      return "skipped_oos";
    }
    if (e instanceof WalletSkip) {
      await notifySubscriptionLowBalance(sub.customerId, title).catch((e: unknown) => console.error("[background task failed]", e));
      return "skipped_lowbalance";
    }
    // Already generated for this (routine, day) — the @@unique guard. No-op.
    if (isUniqueViolation(e)) return "duplicate";
    throw e;
  }

  if (createdOrder) {
    // Each delivery is its own paid order → its own GST invoice (replaces the consolidated statement).
    generateOrderInvoice(createdOrder.id).catch((e: unknown) => console.error("[background task failed]", e));
    notifyNewOrder(createdOrder).catch((e: unknown) => console.error("[background task failed]", e));
    if (plan.skipped.length > 0) {
      notifyRoutineItemsSkipped(sub.customerId, title, plan.skipped.map((s) => s.item.productName)).catch((e: unknown) => console.error("[background task failed]", e));
    }
    if (substituted.length > 0) {
      notifyRoutineSubstituted(sub.customerId, title, substituted).catch((e: unknown) => console.error("[background task failed]", e));
    }
    // "Prices went up" heads-up: only for a run that WAS ordered within the ceiling, only when the rise is
    // meaningful, and only once per level (lastAlertedTotal). An approved run re-baselines, so it just resets.
    const last = sub.lastAlertedTotal == null ? null : Number(sub.lastAlertedTotal);
    const verdict = approved ? (last == null ? "none" : "reset") : shouldAlertPriceChange(plan.drift, plan.totalAmount, last);
    if (verdict === "alert") {
      notifyRoutinePriceUp(sub.customerId, title, plan.drift, plan.totalAmount).catch((e: unknown) => console.error("[background task failed]", e));
    }
    if (verdict !== "none") {
      await prisma.subscription
        .update({ where: { id: sub.id }, data: { lastAlertedTotal: verdict === "alert" ? plan.totalAmount : null } })
        .catch((e: unknown) => console.error("[background task failed]", e));
    }
    // Baseline upkeep: fill missing snapshots; an approved run re-baselines ALL lines to today's price.
    // (Never for a stand-in line: its price is not the original item's "normal".)
    for (const l of plan.lines) {
      if (substitutedIds.has(l.item.id)) continue;
      if (l.item.id.startsWith("legacy:")) continue;
      if (!approved && l.item.unitPriceSnapshot != null) continue;
      await prisma.subscriptionItem
        .update({ where: { id: l.item.id }, data: { unitPriceSnapshot: l.pricing.unitPrice } })
        .catch((e: unknown) => console.error("[background task failed]", e));
    }
  }
  return "generated";
}

/**
 * Read-only: what a run of this routine would deliver and cost RIGHT NOW, against its price ceiling.
 * Feeds the review sheet (and the "held" approve flow). Writes nothing.
 */
export async function quoteRoutine(subscriptionId: string, customerId: string) {
  const sub = await prisma.subscription.findFirst({ where: { id: subscriptionId, customerId }, include: { items: true } });
  if (!sub) return null;
  const row = sub as unknown as RoutineRow;
  const baseItems = resolveRoutineItems(row);
  const variantRows = baseItems.length
    ? await loadVariantRows({ id: { in: baseItems.map((i) => i.variantId) } })
    : [];
  const variantMap = new Map(variantRows.map((v) => [v.id, v]));
  const { items, substituted } = await applySubstitutions(baseItems, variantMap);
  const plan = planRoutineRun(items, variantMap, {
    type: row.priceCeilingType,
    value: Number(row.priceCeilingValue),
  });
  const held = await prisma.subscriptionException.findUnique({
    where: { subscriptionId_date: { subscriptionId, date: istTodayStart() } },
    select: { type: true },
  });
  return {
    name: routineTitle(row),
    total: plan.totalAmount,
    estimate: plan.estimate,
    drift: plan.drift,
    allowedIncrease: plan.allowedIncrease,
    withinCeiling: plan.withinCeiling,
    heldToday: held?.type === "HELD",
    lines: plan.lines.map((l) => ({
      variantId: l.variant.id,
      productName: l.variant.product.name,
      quantity: l.item.quantity,
      unitPrice: l.pricing.unitPrice,
      lineTotal: l.pricing.lineTotal,
    })),
    skipped: plan.skipped.map((s) => ({ variantId: s.item.variantId, productName: s.item.productName, reason: s.reason })),
    substituted,
  };
}

/**
 * The customer approved a HELD run. Allowed for TODAY only (the engine never backfills). Marks the day's
 * exception APPROVED and generates the order at today's prices, ignoring the ceiling.
 */
export async function approveHeldRun(subscriptionId: string, customerId: string): Promise<GenerateResult | "not_held"> {
  const today = istTodayStart();
  const exception = await prisma.subscriptionException.findUnique({
    where: { subscriptionId_date: { subscriptionId, date: today } },
  });
  if (!exception || exception.type !== "HELD") return "not_held";
  const sub = await prisma.subscription.findFirst({
    where: { id: subscriptionId, customerId, status: { not: "CANCELLED" } },
    include: { items: true },
  });
  if (!sub) return "not_held";
  const config = await prisma.storeConfig.findFirst();
  await prisma.subscriptionException.update({ where: { id: exception.id }, data: { type: "APPROVED" } });
  return generateRoutineOrder(sub as unknown as RoutineRow, today, config?.defaultSubscriptionAgentId ?? null, { ignoreCeiling: true });
}

/**
 * Generate orders for every routine due today. Robust catch-up: generates ONLY when today is a
 * genuine cadence day (never backfills missed days), and always resyncs the cursor forward.
 */
export async function generateDueSubscriptionOrders(): Promise<{ generated: number; skipped: number }> {
  const config = await prisma.storeConfig.findFirst();
  if (config && !config.subscriptionsEnabled) return { generated: 0, skipped: 0 };

  const today = istTodayStart();
  const now = new Date();

  const due = await prisma.subscription.findMany({
    where: {
      status: "ACTIVE",
      nextDeliveryDate: { lte: today },
      startDate: { lte: today },
      OR: [{ pausedUntil: null }, { pausedUntil: { lte: now } }],
      AND: [{ OR: [{ endDate: null }, { endDate: { gte: today } }] }],
    },
    include: { items: true },
  });

  let generated = 0;
  let skipped = 0;

  for (const sub of due) {
    try {
      if (isValidDeliveryDay(sub, today)) {
        const result = await generateRoutineOrder(sub as unknown as RoutineRow, today, config?.defaultSubscriptionAgentId ?? null);
        if (result === "generated") generated++;
        else if (result === "skipped_oos" || result === "skipped_lowbalance" || result === "held") skipped++;
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { lastGeneratedDate: today, nextDeliveryDate: computeNextDeliveryDate(sub, today) },
        });
      } else {
        // Missed / non-cadence day → resync the cursor forward, no generation, no backfill.
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { nextDeliveryDate: computeNextDeliveryDate(sub, today) },
        });
      }
    } catch (e) {
      console.error(
        JSON.stringify({ level: "error", msg: "subscription generate failed", subId: sub.id, err: String(e) }),
      );
    }
  }

  if (generated > 0 || skipped > 0) {
    console.log(JSON.stringify({ level: "info", msg: "routine orders generated", generated, skipped }));
  }
  return { generated, skipped };
}


function dayLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(d);
}

/**
 * "Ending soon" reminder for fixed-duration subscriptions (endDate set — "Until I cancel" subs never
 * match). Fires for ACTIVE subscriptions whose endDate is EXACTLY 3 days from today (IST). Deterministic
 * date-equality means each subscription gets exactly one reminder as long as the daily cron runs on that
 * day — no extra "notified" flag/schema needed. A missed cron run on that exact day just skips the
 * reminder (best-effort, same tradeoff as the engine's other notify-only side effects).
 */
export async function notifyEndingSoonSubscriptions(): Promise<{ notified: number }> {
  const today = istTodayStart();
  const target = new Date(today.getTime() + 3 * MS_DAY);

  const ending = await prisma.subscription.findMany({
    where: { status: "ACTIVE", endDate: target },
    select: { customerId: true, productName: true, endDate: true },
  });

  for (const sub of ending) {
    await notifySubscriptionEndingSoon(sub.customerId, sub.productName, dayLabel(sub.endDate!)).catch((e: unknown) => console.error("[background task failed]", e));
  }
  return { notified: ending.length };
}

// ─── Monthly statement close (Phase 3) ────────────────────────────────────────

function monthLabel(year: number, month: number): string {
  const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[month] ?? month} ${year}`;
}

async function settleWallet(
  statementId: string,
  customerId: string,
  amount: number,
  periodYear: number,
  periodMonth: number,
): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const st = await tx.subscriptionStatement.findUnique({
      where: { id: statementId },
      select: { status: true },
    });
    if (!st || st.status === "PAID") return "noop" as const;

    const user = await tx.user.findUnique({ where: { id: customerId }, select: { walletBalance: true } });
    if (!user || Number(user.walletBalance) < amount) {
      await tx.subscriptionStatement.updateMany({
        where: { id: statementId, status: { not: "PAID" } },
        data: { status: "PARTIALLY_PAID" },
      });
      return "insufficient" as const;
    }

    // Guarded claim = idempotency: only one runner flips BILLED/OPEN/PARTIALLY_PAID → PAID.
    const claim = await tx.subscriptionStatement.updateMany({
      where: { id: statementId, status: { in: ["BILLED", "OPEN", "PARTIALLY_PAID"] } },
      data: { status: "PAID", paidAt: new Date() },
    });
    if (claim.count === 0) return "noop" as const; // lost the race

    const dec = await tx.user.updateMany({
      where: { id: customerId, walletBalance: { gte: amount } },
      data: { walletBalance: { decrement: amount } },
    });
    if (dec.count === 0) {
      // Balance changed between read and claim — revert and leave for manual follow-up.
      await tx.subscriptionStatement.update({ where: { id: statementId }, data: { status: "PARTIALLY_PAID", paidAt: null } });
      return "insufficient" as const;
    }

    const fresh = await tx.user.findUnique({ where: { id: customerId }, select: { walletBalance: true } });
    await tx.walletTransaction.create({
      data: {
        userId: customerId,
        amount: -amount,
        type: "ORDER_DEBIT",
        balanceAfter: fresh!.walletBalance,
        statementId,
        note: `Subscription bill ${monthLabel(periodYear, periodMonth)}`,
      },
    });
    await tx.order.updateMany({ where: { statementId }, data: { paymentStatus: "PAID" } });
    return "paid" as const;
  });

  if (result === "paid") {
    // Mark the consolidated invoice PAID + record store revenue (wallet → bank-transfer mode).
    await markStatementInvoicePaid(statementId, "BANK_TRANSFER").catch((e: unknown) => console.error("[background task failed]", e));
    await notifySubscriptionStatement(customerId, {
      amount,
      periodLabel: monthLabel(periodYear, periodMonth),
      autoPaid: true,
    }).catch((e: unknown) => console.error("[background task failed]", e));
  } else if (result === "insufficient") {
    await notifySubscriptionStatement(customerId, {
      amount,
      periodLabel: monthLabel(periodYear, periodMonth),
      autoPaid: false,
    }).catch((e: unknown) => console.error("[background task failed]", e));
  }
}

interface StatementGroup {
  customerId: string;
  billing: "COD" | "WALLET" | "AUTOPAY";
  orderIds: string[];
  total: number;
}

async function settleStatement(g: StatementGroup, periodYear: number, periodMonth: number): Promise<void> {
  const statement = await prisma.$transaction(async (tx) => {
    const st = await tx.subscriptionStatement.upsert({
      where: {
        customerId_periodYear_periodMonth_billing: {
          customerId: g.customerId,
          periodYear,
          periodMonth,
          billing: g.billing,
        },
      },
      create: {
        customerId: g.customerId,
        periodYear,
        periodMonth,
        billing: g.billing,
        totalAmount: g.total,
        deliveryCount: g.orderIds.length,
        status: "BILLED",
      },
      // Stragglers (a late delivery after a prior close) bump the existing statement. Rare.
      update: {
        totalAmount: { increment: g.total },
        deliveryCount: { increment: g.orderIds.length },
      },
    });
    await tx.order.updateMany({ where: { id: { in: g.orderIds } }, data: { statementId: st.id } });
    return st;
  });

  // Consolidated GST invoice — best-effort (the bill still stands if the PDF/invoice fails).
  try {
    const invId = await generateStatementInvoice(statement.id);
    if (invId) {
      await prisma.subscriptionStatement.update({ where: { id: statement.id }, data: { invoiceId: invId } });
    }
  } catch (e) {
    console.error("statement invoice failed:", e);
  }

  if (g.billing === "WALLET") {
    await settleWallet(statement.id, g.customerId, Number(statement.totalAmount), periodYear, periodMonth);
  } else {
    // COD → owner marks paid when cash is collected (D6). AUTOPAY → Phase 4. Notify either way.
    await notifySubscriptionStatement(g.customerId, {
      amount: Number(statement.totalAmount),
      periodLabel: monthLabel(periodYear, periodMonth),
      autoPaid: false,
    }).catch((e: unknown) => console.error("[background task failed]", e));
  }
}

/**
 * On/after StoreConfig.subscriptionBillingDay, close the PRIOR IST month: one statement per customer
 * per billing tender, aggregating that month's DELIVERED MONTHLY orders. Idempotent (orders already
 * on a statement are excluded; re-runs find nothing).
 */
export async function closeMonthlyStatements(now: Date = new Date()): Promise<{ billed: number }> {
  const config = await prisma.storeConfig.findFirst();
  const billingDay = config?.subscriptionBillingDay ?? 1;

  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  if (istNow.getUTCDate() < billingDay) return { billed: 0 };

  // Prior IST month.
  const prior = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth() - 1, 1));
  const periodYear = prior.getUTCFullYear();
  const periodMonth = prior.getUTCMonth() + 1; // 1..12

  const monthStart = istMidnight(new Date(Date.UTC(periodYear, periodMonth - 1, 1)));
  const monthEnd = istMidnight(new Date(Date.UTC(periodYear, periodMonth, 1))); // exclusive

  const orders = await prisma.order.findMany({
    where: {
      paymentMethod: "MONTHLY",
      status: "DELIVERED",
      statementId: null,
      deliveredAt: { gte: monthStart, lt: monthEnd },
    },
    select: {
      id: true,
      customerId: true,
      totalAmount: true,
      subscription: { select: { billing: true } },
    },
  });
  if (orders.length === 0) return { billed: 0 };

  const groups = new Map<string, StatementGroup>();
  for (const o of orders) {
    const billing = (o.subscription?.billing ?? "COD") as StatementGroup["billing"];
    const key = `${o.customerId}|${billing}`;
    const g = groups.get(key) ?? { customerId: o.customerId, billing, orderIds: [], total: 0 };
    g.orderIds.push(o.id);
    g.total = round2(g.total + Number(o.totalAmount));
    groups.set(key, g);
  }

  let billed = 0;
  for (const g of groups.values()) {
    try {
      await settleStatement(g, periodYear, periodMonth);
      billed++;
    } catch (e) {
      console.error(
        JSON.stringify({ level: "error", msg: "statement close failed", customerId: g.customerId, err: String(e) }),
      );
    }
  }

  if (billed > 0) {
    console.log(JSON.stringify({ level: "info", msg: "subscription statements billed", billed, periodYear, periodMonth }));
  }
  return { billed };
}

// ─── Sweeper (backup driver — the external cron is the real one) ──────────────

export function startSubscriptionSweeper(intervalMs = 30 * 60 * 1000): void {
  const timer = setInterval(() => {
    generateDueSubscriptionOrders().catch((e) =>
      console.error(JSON.stringify({ level: "error", msg: "subscription sweep crashed", err: String(e) })),
    );
    closeMonthlyStatements().catch((e) =>
      console.error(JSON.stringify({ level: "error", msg: "statement close crashed", err: String(e) })),
    );
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
