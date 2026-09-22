import prisma from "../lib/prisma.js";
import { RETURN_TYPES, listFiledPeriods, periodOf } from "./filedPeriods.js";

/**
 * The PLATFORM's own profit and loss, and what it is holding for other people (runbook step 21).
 *
 * ⚠️ THIS IS NOT THE SHOP'S P&L. The shop's sales, cost of goods and margin are its own business and
 * live in services/reports.ts. What is here is the marketplace operator's: it earns commission on
 * other people's sales and a delivery fee, it funds promotions out of its own pocket, and it holds
 * money that belongs to sellers, to customers and to the government. Mixing the two produces a
 * number that is nobody's profit — and step 23 is the day they legally become two entities, so the
 * separation has to exist before then rather than after.
 *
 * ⚠️ THERE IS NO CASH POSITION HERE, AND THAT IS NOT AN OMISSION. A cash position needs a bank
 * balance, and this system has never seen one — no bank feed, no opening balance, nothing that
 * reconciles to an account. What it CAN state precisely is the total of what the platform owes other
 * people, which is the half that is actually derivable. Printing a "net cash" figure by subtracting
 * obligations from a number we do not have would be an invention with a rupee sign on it.
 *
 * ⚠️ Every figure is summed from a stored column. Nothing is recomputed from a rate — the same rule
 * the settlement statement runs on, and for the same reason.
 *
 * ⚠️ READ THE MARGIN WITH THE ENTITY SPLIT IN MIND, or it will look alarming for the wrong reason.
 * Today almost every order is the HOUSE store's, and the platform and the shop are one business —
 * so the coupons and member discounts on this cost side are the shop's own marketing, funded and
 * earned by the same pocket, while the commission income against them is only what the two real
 * external sellers generated. The margin is therefore deeply negative and means very little: it is
 * one entity paying for promotions on its own goods with no internal commission to show for it.
 *
 * It starts meaning something on the day StoreConfig.houseSellerIsSeparateEntity goes true (step 23).
 * From then the shop is a seller like any other, its sales carry real commission INTO this income
 * line, and the promotional spend becomes a genuine cost of running a marketplace rather than an
 * accounting artefact. Do not "fix" the negative number before then — there is nothing wrong with it.
 */

const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);

export interface PlatformPl {
  from: Date;
  to: Date;
  income: {
    /** Commission the platform charged sellers on their sales. */
    commission: number;
    /** The delivery fee, GST-exclusive — the platform's own supply (step 15). */
    deliveryNet: number;
    /**
     * ⚠️ Delivery charged on orders placed BEFORE step 15, where the fee was never split into base
     * and tax. It is NOT added to income: its GST-exclusive value is unknown, and quietly treating
     * the gross as income would overstate the platform's earnings by the tax inside it.
     */
    deliveryUnsplit: number;
    deliveryUnsplitOrderCount: number;
    total: number;
  };
  cost: {
    /** Coupons the platform funded. Never reaches the seller — their slice is written gross. */
    coupons: number;
    /** Standing member discount given under the loyalty programme. */
    loyalty: number;
    /** Delivery fees waived specifically by a member's free-delivery perk. */
    deliveryWaived: number;
    total: number;
  };
  margin: number;
  /** Collected on somebody else's behalf. Income to nobody — it is owed onward. */
  heldForGovernment: {
    commissionGst: number;
    deliveryGst: number;
    tcs: number;
    tds: number;
    total: number;
  };
  orderCount: number;
}

export interface PlatformBalanceSheet {
  asOf: Date;
  owedToSellers: {
    /** Σ Seller.outstandingBalance — the ledger's own figure. */
    stored: number;
    /** Re-derived from unsettled, uncancelled slices — what the ledger SHOULD say. */
    derived: number;
    /** Signed. Non-zero means the ledger and the orders behind it disagree. */
    drift: number;
    reconciles: boolean;
    bySeller: { sellerId: string; name: string; stored: number; derived: number }[];
  };
  /** Customer money the platform is holding as store credit. */
  customerStoreCredit: number;
  /** Tax accrued in periods that have NOT been filed yet — still to be remitted. */
  taxNotYetFiled: { tcs: number; commissionGst: number; deliveryGst: number; tds: number; total: number };
  /** Everything the platform owes somebody else. NOT netted against cash — see the file header. */
  totalObligations: number;
}

export async function buildPlatformPl(from: Date, to: Date): Promise<PlatformPl> {
  const liveOrder = { status: { not: "CANCELLED" as const }, createdAt: { gte: from, lte: to } };

  const [slices, orders, unsplit] = await Promise.all([
    prisma.subOrder.aggregate({
      where: { status: { not: "CANCELLED" }, order: { is: liveOrder } },
      _sum: { commissionAmount: true, commissionGstAmount: true, tcsAmount: true, tdsAmount: true },
    }),
    prisma.order.aggregate({
      where: liveOrder,
      _sum: {
        deliveryTaxable: true, deliveryGst: true,
        discount: true, loyaltyDiscount: true, tierDeliveryWaived: true,
      },
      _count: true,
    }),
    // Pre-step-15 orders: a real fee, no split. Counted and reported, never folded into income.
    prisma.order.aggregate({
      where: { ...liveOrder, deliveryTaxable: null, deliveryCharge: { gt: 0 } },
      _sum: { deliveryCharge: true },
      _count: true,
    }),
  ]);

  const commission = r2(n(slices._sum.commissionAmount));
  const deliveryNet = r2(n(orders._sum.deliveryTaxable));
  const incomeTotal = r2(commission + deliveryNet);

  // ⚠️ Order.discount is coupon AND loyalty combined (routes/orders.ts writes them as one figure so
  // the order reconciles). Subtracting loyalty out is what stops the member discount being counted
  // twice — once as itself and once inside the coupon line.
  const loyalty = r2(n(orders._sum.loyaltyDiscount));
  const coupons = r2(n(orders._sum.discount) - loyalty);
  const deliveryWaived = r2(n(orders._sum.tierDeliveryWaived));
  const costTotal = r2(coupons + loyalty + deliveryWaived);

  const commissionGst = r2(n(slices._sum.commissionGstAmount));
  const deliveryGst = r2(n(orders._sum.deliveryGst));
  const tcs = r2(n(slices._sum.tcsAmount));
  const tds = r2(n(slices._sum.tdsAmount));

  return {
    from,
    to,
    income: {
      commission,
      deliveryNet,
      deliveryUnsplit: r2(n(unsplit._sum.deliveryCharge)),
      deliveryUnsplitOrderCount: unsplit._count,
      total: incomeTotal,
    },
    cost: { coupons, loyalty, deliveryWaived, total: costTotal },
    margin: r2(incomeTotal - costTotal),
    heldForGovernment: {
      commissionGst, deliveryGst, tcs, tds,
      total: r2(commissionGst + deliveryGst + tcs + tds),
    },
    orderCount: orders._count,
  };
}

export async function buildPlatformBalanceSheet(): Promise<PlatformBalanceSheet> {
  const asOf = new Date();

  // ── Owed to sellers ─────────────────────────────────────────────────────────────────────────
  //
  // ⚠️ BOTH NUMBERS, ALWAYS. The runbook's prove is that the balance sheet's payable equals
  // Σ Seller.outstandingBalance — but a report that simply PRINTS that column can never fail that
  // test, because it is quoting the thing it is supposed to be checked against. Deriving it a second
  // way from the slices is what makes the check mean something. They were ₹186.12 apart until a
  // legacy unreversed accrual was repaired; the drift is reported rather than hidden either way.
  const sellers = await prisma.seller.findMany({
    where: { isHouse: false },
    select: { id: true, name: true, outstandingBalance: true },
    orderBy: { name: "asc" },
  });
  const derivedRows = await prisma.subOrder.groupBy({
    by: ["sellerId"],
    where: { settled: false, status: { not: "CANCELLED" }, order: { is: { status: { not: "CANCELLED" } } } },
    _sum: { netPayable: true },
  });
  const derivedBySeller = new Map(derivedRows.map((r) => [r.sellerId, r2(n(r._sum.netPayable))]));
  // Unsettled adjustments are part of what is owed too — a credit raises it, a clawback lowers it.
  const adjRows = await prisma.subOrderAdjustment.groupBy({
    by: ["sellerId"],
    where: { settled: false },
    _sum: { amount: true },
  });
  for (const a of adjRows) {
    derivedBySeller.set(a.sellerId, r2((derivedBySeller.get(a.sellerId) ?? 0) + n(a._sum.amount)));
  }

  const bySeller = sellers.map((s) => ({
    sellerId: s.id,
    name: s.name,
    stored: r2(n(s.outstandingBalance)),
    derived: derivedBySeller.get(s.id) ?? 0,
  }));
  const stored = r2(bySeller.reduce((t, s) => t + s.stored, 0));
  const derived = r2(bySeller.reduce((t, s) => t + s.derived, 0));
  const drift = r2(stored - derived);

  // ── Customer store credit ───────────────────────────────────────────────────────────────────
  const wallet = await prisma.user.aggregate({ _sum: { walletBalance: true } });
  const customerStoreCredit = r2(n(wallet._sum.walletBalance));

  // ── Tax accrued in periods nobody has filed ─────────────────────────────────────────────────
  //
  // ⚠️ "Not yet filed" is read from FiledTaxPeriod, not from a date. A period is outstanding until
  // somebody says it went out — which is the whole point of step 18's record.
  const filed = await listFiledPeriods(RETURN_TYPES.GSTR8);
  const filedGstr8 = new Set(filed.map((f) => f.period));
  const filedGstr1 = new Set((await listFiledPeriods(RETURN_TYPES.GSTR1)).map((f) => f.period));

  const sliceRows = await prisma.subOrder.findMany({
    where: { status: { not: "CANCELLED" }, order: { is: { status: { not: "CANCELLED" } } } },
    select: { createdAt: true, tcsAmount: true, tdsAmount: true, commissionGstAmount: true },
  });
  let tcs = 0, tds = 0, commissionGst = 0;
  for (const s of sliceRows) {
    const p = periodOf(s.createdAt);
    if (!filedGstr8.has(p)) tcs += n(s.tcsAmount);
    // TDS is an income-tax return, not GSTR-8 — it has no FiledTaxPeriod of its own yet, so every
    // rupee of it reads as outstanding. Honest today (194-O is off and every figure is 0); revisit
    // when step 24 turns it on.
    tds += n(s.tdsAmount);
    if (!filedGstr1.has(p)) commissionGst += n(s.commissionGstAmount);
  }

  const orderRows = await prisma.order.findMany({
    where: { status: { not: "CANCELLED" }, deliveryGst: { not: null } },
    select: { createdAt: true, deliveryGst: true },
  });
  let deliveryGst = 0;
  for (const o of orderRows) {
    if (!filedGstr1.has(periodOf(o.createdAt))) deliveryGst += n(o.deliveryGst);
  }

  const taxNotYetFiled = {
    tcs: r2(tcs), commissionGst: r2(commissionGst), deliveryGst: r2(deliveryGst), tds: r2(tds),
    total: r2(tcs + commissionGst + deliveryGst + tds),
  };

  return {
    asOf,
    owedToSellers: { stored, derived, drift, reconciles: Math.abs(drift) < 0.005, bySeller },
    customerStoreCredit,
    taxNotYetFiled,
    totalObligations: r2(stored + customerStoreCredit + taxNotYetFiled.total),
  };
}
