import prisma from "../lib/prisma.js";
import { toAppFormat } from "../utils/looseUnitConverter.js";
import { getNextOrderNumber } from "./orderNumbering.js";
import {
  notifyNewOrder,
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

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions engine (milk / newspaper / recurring deliveries).
//
// Three responsibilities:
//   1. Pricing a single subscription delivery — FREE delivery, no coupon/loyalty/wallet/bulk
//      (see priceSubscriptionDelivery). This deliberately does NOT call calculateCartTotals, which
//      would force a per-order delivery charge (cartPricing.ts:182-188) and apply discounts we don't
//      want per delivery. Bug-isolation over DRY.
//   2. Turning due subscriptions into real Orders (paymentMethod=MONTHLY, status=PACKED) that flow
//      through the existing delivery pipeline. Mirrors the order-placement transaction (routes/orders.ts)
//      stripped to a deferred single-seller order.
//   3. Closing one consolidated monthly statement per customer per tender, settled by wallet/COD.
//
// All dates use IST-midnight semantics (reuses the IST pattern from routes/delivery.ts).
// ─────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_DAY = 24 * 60 * 60 * 1000;

// GST Sec-52 TCS the platform collects on EXTERNAL sellers' net taxable supplies (house = 0).
// Mirrors routes/orders.ts:29. ⚠️ GST/CA — confirm before launch.
const TCS_RATE_PCT = 1;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function isLooseType(t: string): boolean {
  return t === "LOOSE" || t === "PRODUCE";
}

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
}

/**
 * Per-variant planning totals for a target delivery day — "Tomorrow: 40× Milk 500ml, 12× Newspaper" —
 * how many of each to stock/pack. Optionally scoped to one seller's own products (via
 * variant.product.sellerId) so a seller sees only their own subscribers, not the whole store's. Shared
 * by the owner's and seller's `/upcoming` routes (was duplicated inline in ownerSubscriptions.ts).
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
      ...(productFilter ? { variant: { product: productFilter } } : {}),
    },
  });

  const byVariant = new Map<string, SubscriptionPlanRow>();
  for (const sub of subs) {
    const cadence: CadenceLike = {
      frequency: sub.frequency as CadenceLike["frequency"],
      intervalDays: sub.intervalDays,
      daysOfWeek: sub.daysOfWeek,
      dayOfMonth: sub.dayOfMonth,
      startDate: sub.startDate,
      endDate: sub.endDate,
    };
    if (!isValidDeliveryDay(cadence, target)) continue;
    const row = byVariant.get(sub.variantId) ?? {
      variantId: sub.variantId,
      productName: sub.productName,
      unit: sub.stepUnit ?? "",
      isLoose: sub.isLoose,
      totalQty: 0,
      customerCount: 0,
    };
    row.totalQty = +(row.totalQty + Number(sub.quantity)).toFixed(3);
    row.customerCount += 1;
    byVariant.set(sub.variantId, row);
  }
  return [...byVariant.values()].sort((a, b) => b.totalQty - a.totalQty);
}

// ─── Pricing (the 🩹 delivery-charge fix) ─────────────────────────────────────

interface PricedVariant {
  packageSize: unknown;
  packageUnit: string;
  sellingPrice: unknown;
  mrp: unknown;
  bulkMinQty: number;
  bulkPrice: unknown;
  gstRateOverride: unknown;
  product: { productType: string; gstRate: unknown };
}

export interface SubscriptionPricing {
  unitPrice: number;
  mrp: number;
  lineTotal: number;
  gstRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  totalTax: number;
  subtotal: number;
  deliveryCharge: 0;
  totalAmount: number;
  savedAmount: number;
}

/**
 * Prices ONE subscription line at face value: GST-inclusive line total, NO delivery, NO coupon,
 * NO loyalty, NO wallet, NO bulk (D9). Mirrors the per-line GST math in cartPricing.ts:99-107.
 */
export function priceSubscriptionDelivery(variant: PricedVariant, quantity: number): SubscriptionPricing {
  const isLoose = isLooseType(variant.product.productType);
  const converted = toAppFormat(variant as never, isLoose);
  const unitPrice = converted.sellingPrice; // never bulkPrice
  const mrp = converted.mrp;
  const lineTotal = round2(unitPrice * quantity);

  const gstRate =
    variant.gstRateOverride != null
      ? Number(variant.gstRateOverride)
      : variant.product.gstRate != null
        ? Number(variant.product.gstRate)
        : 0;

  const taxableValue = gstRate > 0 ? round2(lineTotal / (1 + gstRate / 100)) : lineTotal;
  const totalTax = round2(lineTotal - taxableValue);
  const cgst = round2(totalTax / 2);
  const sgst = round2(totalTax - cgst);
  const savedAmount = round2(Math.max(0, mrp - unitPrice) * quantity);

  return {
    unitPrice,
    mrp,
    lineTotal,
    gstRate,
    taxableValue,
    cgst,
    sgst,
    totalTax,
    subtotal: lineTotal,
    deliveryCharge: 0,
    totalAmount: lineTotal,
    savedAmount,
  };
}

// ─── Generation (one Order per due subscription per day) ──────────────────────

type GenerateResult =
  | "generated"
  | "skipped_oos"
  | "skipped_lowbalance"
  | "skipped_date"
  | "duplicate";

async function generateOrderFor(
  sub: {
    id: string;
    customerId: string;
    variantId: string;
    quantity: unknown;
    productName: string;
    imageUrl: string | null;
    addressId: string | null;
    billing: string; // "WALLET" | "COD" | "AUTOPAY"
    mandateId: string | null;
  },
  dayIST: Date,
  defaultAgentId: string | null,
): Promise<GenerateResult> {
  // Calendar skip: the customer marked this date off (before the cutoff). No delivery, no charge.
  const exception = await prisma.subscriptionException.findUnique({
    where: { subscriptionId_date: { subscriptionId: sub.id, date: dayIST } },
  });
  if (exception && exception.type === "SKIP") return "skipped_date";

  const variant = await prisma.productVariant.findUnique({
    where: { id: sub.variantId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          productType: true,
          hsnCode: true,
          gstRate: true,
          isPackaged: true,
          categoryId: true,
          imageUrls: true,
          sellerId: true,
        },
      },
    },
  });

  // Product gone/inactive — skip + notify (treat like OOS; never throw).
  if (!variant || !variant.isActive) {
    await notifySubscriptionSkipped(sub.customerId, sub.productName).catch(() => {});
    return "skipped_oos";
  }

  const qty = Number(sub.quantity);
  const isLoose = isLooseType(variant.product.productType);
  // needed = base-unit demand. Mirrors routes/orders.ts:142 exactly.
  const needed = isLoose ? qty * Number(variant.packageSize) : qty;
  const pricing = priceSubscriptionDelivery(variant as never, qty);

  const [address, customer, houseSeller, orderNumber] = await Promise.all([
    sub.addressId ? prisma.address.findUnique({ where: { id: sub.addressId } }) : Promise.resolve(null),
    prisma.user.findUnique({ where: { id: sub.customerId }, select: { name: true, phone: true } }),
    prisma.seller.findFirst({ where: { isHouse: true }, select: { id: true } }),
    getNextOrderNumber(),
  ]);

  const sellerId = variant.product.sellerId ?? houseSeller?.id ?? null;

  // ── Resolve the payment tender BEFORE the txn (prepaid-first — never postpaid). ──
  const total = pricing.totalAmount;
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
      await notifySubscriptionLowBalance(sub.customerId, sub.productName).catch(() => {});
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

  let createdOrder: { id: string; orderNumber: string; totalAmount: unknown; customerId: string } | null = null;

  try {
    createdOrder = await prisma.$transaction(async (tx) => {
      // FIFO-consume the needed base-units (mirrors routes/orders.ts's own consumeFifo call).
      // consumeFifo throws AppError("INSUFFICIENT_STOCK") when it runs out of batches before
      // satisfying `needed` — translate that into the existing OosSkip sentinel so the outer
      // catch's "skip + notify, never a hard error" behavior is unchanged.
      let consumeResult: ConsumeResult;
      try {
        consumeResult = await consumeFifo(tx, variant.id, needed);
      } catch (e) {
        if (e instanceof AppError && e.code === "INSUFFICIENT_STOCK") throw new OosSkip();
        throw e;
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
          subtotal: pricing.subtotal,
          discount: 0,
          deliveryCharge: 0, // 🩹 subscription deliveries are free (D4)
          taxableValue: pricing.taxableValue,
          totalTax: pricing.totalTax,
          totalAmount: pricing.totalAmount,
          savedAmount: pricing.savedAmount,
          walletApplied: walletFunded ? total : 0,
          deliveryOtpRequired: false,
          deliveryBoyId: defaultAgentId,
          subscriptionId: sub.id,
          subscriptionDate: dayIST, // idempotency key with @@unique([subscriptionId, subscriptionDate])
          items: {
            create: [
              {
                variantId: variant.id,
                productName: variant.product.name,
                variantSku: variant.sku,
                imageUrl: variant.product.imageUrls?.[0] ?? sub.imageUrl ?? null,
                hsnCode: variant.product.hsnCode,
                unitPrice: pricing.unitPrice,
                mrp: pricing.mrp,
                quantity: sub.quantity as never,
                gstRate: pricing.gstRate,
                taxableValue: pricing.taxableValue,
                cgst: pricing.cgst,
                sgst: pricing.sgst,
                lineTotal: pricing.lineTotal,
                isLoose,
                stepSize: isLoose ? Number(variant.packageSize) : null,
                stepUnit: isLoose ? variant.packageUnit : null,
                packageUnit: variant.packageUnit,
                sellerId,
                costPriceSnapshot: consumeResult.totalQty > 0 ? consumeResult.weightedUnitCost : null,
              },
            ],
          },
        },
        select: { id: true, orderNumber: true, totalAmount: true, customerId: true, items: { select: { id: true } } },
      });

      // Single item, single variant per subscription delivery — no ambiguity to resolve.
      if (created.items[0]) await recordConsumption(tx, { orderItemId: created.items[0].id }, consumeResult.consumed);

      // Prepaid-wallet: guarded debit + ledger row, atomic with the order. Insufficient balance →
      // WalletSkip rolls back the stock decrement + order (we never deliver unpaid). @@unique([orderId,
      // type]) makes the debit idempotent (the order is created once per subscription-day).
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
            note: `Subscription: ${variant.product.name}`,
          },
        });
      }

      // One SubOrder for the (single) seller — mirrors routes/orders.ts:294-354 simplified.
      // House seller → commission 0, TCS 0, no payout accrual. Keeps the delivery feed + statement
      // invoice consistent with every other order.
      if (sellerId) {
        const seller = await tx.seller.findUnique({
          where: { id: sellerId },
          select: { id: true, commissionPct: true, isHouse: true, pan: true, entityType: true },
        });
        if (seller) {
          const subtotal = pricing.lineTotal;
          const commissionPct = Number(seller.commissionPct);
          const commissionAmount = +((subtotal * commissionPct) / 100).toFixed(2);
          const tcsAmount = seller.isHouse ? 0 : +((pricing.taxableValue * TCS_RATE_PCT) / 100).toFixed(2);
          // Sec 194-O TDS — same discipline as routes/orders.ts. Off (0) unless StoreConfig.tds194oEnabled.
          const { tdsAmount } = await computeSubOrderTds194o(tx, seller, subtotal);
          const netPayable = +(subtotal - commissionAmount - tcsAmount - tdsAmount).toFixed(2);

          const subOrder = await tx.subOrder.create({
            data: {
              orderId: created.id,
              sellerId,
              status: "PACKED",
              subtotal,
              commissionPct,
              commissionAmount,
              tcsAmount,
              tdsAmount,
              netPayable,
            },
          });
          await tx.orderItem.updateMany({
            where: { orderId: created.id },
            data: { subOrderId: subOrder.id },
          });
          if (!seller.isHouse) {
            await tx.seller.update({
              where: { id: sellerId },
              data: { outstandingBalance: { increment: netPayable } },
            });
          }
        }
      }

      return created;
    });
  } catch (e) {
    if (e instanceof OosSkip) {
      await notifySubscriptionSkipped(sub.customerId, sub.productName).catch(() => {});
      return "skipped_oos";
    }
    if (e instanceof WalletSkip) {
      await notifySubscriptionLowBalance(sub.customerId, sub.productName).catch(() => {});
      return "skipped_lowbalance";
    }
    // Already generated for this (subscription, day) — the @@unique guard. No-op.
    if (isUniqueViolation(e)) return "duplicate";
    throw e;
  }

  if (createdOrder) {
    // Each delivery is its own paid order → its own GST invoice (replaces the consolidated statement).
    generateOrderInvoice(createdOrder.id).catch(() => {});
    notifyNewOrder(createdOrder).catch(() => {});
  }
  return "generated";
}

/**
 * Generate orders for every subscription due today. Robust catch-up: generates ONLY when today is a
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
  });

  let generated = 0;
  let skipped = 0;

  for (const sub of due) {
    try {
      if (isValidDeliveryDay(sub, today)) {
        const result = await generateOrderFor(sub, today, config?.defaultSubscriptionAgentId ?? null);
        if (result === "generated") generated++;
        else if (result === "skipped_oos" || result === "skipped_lowbalance") skipped++;
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
    console.log(JSON.stringify({ level: "info", msg: "subscription orders generated", generated, skipped }));
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
    await notifySubscriptionEndingSoon(sub.customerId, sub.productName, dayLabel(sub.endDate!)).catch(() => {});
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
    await markStatementInvoicePaid(statementId, "BANK_TRANSFER").catch(() => {});
    await notifySubscriptionStatement(customerId, {
      amount,
      periodLabel: monthLabel(periodYear, periodMonth),
      autoPaid: true,
    }).catch(() => {});
  } else if (result === "insufficient") {
    await notifySubscriptionStatement(customerId, {
      amount,
      periodLabel: monthLabel(periodYear, periodMonth),
      autoPaid: false,
    }).catch(() => {});
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
    }).catch(() => {});
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
