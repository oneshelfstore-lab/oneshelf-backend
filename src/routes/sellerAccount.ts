import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { memoCache } from "../lib/httpCache.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { isValidGstin } from "../validators/index.js";
import { PARTNER_AGREEMENT_VERSION } from "../data/onboardingAgreements.js";

// A GSTIN is optional (a seller may be unregistered) but, when present, must be well-formed +
// checksum-valid so invoices are never issued under a malformed GSTIN (COMPLIANCE_PLAN.md P2-3).
const optionalGstin = z.string().max(15).optional().nullable().refine(
  (v) => v == null || v === "" || isValidGstin(v).valid,
  { message: "Invalid GSTIN — check the 15-character format and checksum" },
);

// FSSAI license/registration numbers are always exactly 14 digits (Phase 2,
// SELLER_DELIVERY_ONBOARDING_PLAN.md — "FSSAI number/expiry format validation"). Format-only: NOT
// hard-required at submit (see the submit handler below) and an already-expired date isn't blocked
// either — that's the still-open "enforcement strictness" decision from the plan, not this pass.
const optionalFssaiNumber = z.string().max(20).optional().nullable().refine(
  (v) => !v || /^[0-9]{14}$/.test(v.trim()),
  { message: "FSSAI number must be exactly 14 digits" },
);

// Seller-scoped profile + earnings. Mounted at /api/app/seller/me.
//   GET  /            → shop profile
//   PUT  /            → update editable profile fields (NOT commission/status — admin-controlled)
//   GET  /earnings    → gross / commission / net, outstanding balance, payout history
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("SELLER") as any);
router.use(resolveSeller as any);

function shapeProfile(s: any, agreementCurrent: boolean) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    logoUrl: s.logoUrl,
    shopAddress: s.shopAddress,
    city: s.city,
    pincode: s.pincode,
    lat: s.lat != null ? Number(s.lat) : null,
    lng: s.lng != null ? Number(s.lng) : null,
    phone: s.phone,
    gstin: s.gstin,
    pan: s.pan,
    bankDetails: s.bankDetails ?? null,
    // Settlement bank account for payouts (§ PUT /bank-details below). Masked here — the raw
    // account number only ever needs to be entered once, not re-displayed on every profile load.
    hasBankDetails: Boolean((s.bankDetails as any)?.accountNumber),
    bankLast4: (s.bankDetails as any)?.accountNumber ? String((s.bankDetails as any).accountNumber).slice(-4) : null,
    commissionPct: Number(s.commissionPct),
    outstandingBalance: Number(s.outstandingBalance),
    status: s.status,
    isActive: s.isActive,
    // House manager (the store's own catalog) → the app shows the owner-level merchandising toggles
    // + a "goes live now" note in the product editor.
    isHouse: s.isHouse,
    // ─── Onboarding KYC (Phase 1) ──
    fssaiNumber: s.fssaiNumber,
    fssaiExpiry: s.fssaiExpiry,
    fssaiDocUrl: s.fssaiDocUrl,
    gstinDocUrl: s.gstinDocUrl,
    panDocUrl: s.panDocUrl,
    bankProofUrl: s.bankProofUrl,
    grievanceOfficerName: s.grievanceOfficerName,
    grievanceOfficerPhone: s.grievanceOfficerPhone,
    grievanceOfficerEmail: s.grievanceOfficerEmail,
    onboardingStatus: s.onboardingStatus,
    onboardingRejectionReason: s.onboardingRejectionReason,
    // ─── Consent-version re-prompt (Phase 2) ──
    // True once this seller's LATEST granted partner-agreement consent matches the current
    // PARTNER_AGREEMENT_VERSION. False after a legal-text version bump — the app re-gates an
    // already-APPROVED seller behind a lightweight re-accept screen until they tap "I agree" again.
    // A seller who's never consented at all (pre-dates Phase 1 entirely) reads as true — nothing
    // to re-prompt for someone who was never asked in the first place.
    agreementCurrent,
  };
}

// True once the seller's latest granted PARTNER_AGREEMENT consent matches the CURRENT version.
async function isAgreementCurrent(sellerId: string): Promise<boolean> {
  const latest = await prisma.consentRecord.findFirst({
    where: { subjectType: "SELLER", subjectId: sellerId, consentType: "PARTNER_AGREEMENT", granted: true },
    orderBy: { grantedAt: "desc" },
  });
  return latest == null || latest.version === PARTNER_AGREEMENT_VERSION;
}

// ─── GET / — shop profile ─────────────────────────────────────────
router.get("/", async (req: SellerRequest, res: Response) => {
  try {
    const seller = await prisma.seller.findUnique({ where: { id: req.sellerId } });
    if (!seller) throw new NotFoundError("Seller", req.sellerId ?? "");
    const agreementCurrent = await isAgreementCurrent(seller.id);
    res.json({ success: true, data: shapeProfile(seller, agreementCurrent) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── PUT / — update editable profile fields (also the onboarding KYC draft — progressive save,
// not one big submit; call POST /onboarding/submit when ready for owner review) ───────────────
const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  logoUrl: z.string().max(500).optional().nullable(),
  shopAddress: z.string().max(300).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  pincode: z.string().max(10).optional().nullable(),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
  phone: z.string().max(15).optional().nullable(),
  gstin: optionalGstin,
  pan: z.string().max(10).optional().nullable(),
  bankDetails: z.any().optional().nullable(),
  // Onboarding KYC (Phase 1) — document fields are Firebase Storage URLs, uploaded client-side
  // (same convention as every other photo field in this app; see util/ImageUploadUtil.kt).
  fssaiNumber: optionalFssaiNumber,
  fssaiExpiry: z.coerce.date().optional().nullable(),
  fssaiDocUrl: z.string().max(500).optional().nullable(),
  gstinDocUrl: z.string().max(500).optional().nullable(),
  panDocUrl: z.string().max(500).optional().nullable(),
  bankProofUrl: z.string().max(500).optional().nullable(),
  grievanceOfficerName: z.string().max(120).optional().nullable(),
  grievanceOfficerPhone: z.string().max(15).optional().nullable(),
  grievanceOfficerEmail: z.string().email().max(160).optional().nullable(),
});

router.put("/", async (req: SellerRequest, res: Response) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid profile data", parsed.error.errors);

    const current = await prisma.seller.findUnique({ where: { id: req.sellerId }, select: { onboardingStatus: true } });
    if (!current) throw new NotFoundError("Seller", req.sellerId ?? "");

    const updated = await prisma.seller.update({
      where: { id: req.sellerId },
      data: {
        ...parsed.data,
        // Editing after submission means the owner would be reviewing stale data — un-submit so
        // the seller has to re-submit once they're done changing things.
        ...(current.onboardingStatus === "PENDING_REVIEW" ? { onboardingStatus: "IN_PROGRESS" as const } : {}),
      },
    });
    res.json({ success: true, data: shapeProfile(updated, await isAgreementCurrent(updated.id)) });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /api/app/seller/me/bank-details { accountName, accountNumber, ifsc } → the account this
// seller's monthly payout is settled to. Its own small validated route (not the generic PUT / above,
// whose `bankDetails: z.any()` accepts anything) — mirrors appUser.ts's identical referral-payout
// bank-details route so both money-settlement flows validate the same way.
const bankDetailsSchema = z.object({
  accountName: z.string().trim().min(2).max(100),
  accountNumber: z.string().regex(/^\d{9,18}$/, "Invalid account number"),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC code"),
});

router.put("/bank-details", async (req: SellerRequest, res: Response) => {
  try {
    const parsed = bankDetailsSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid bank details", parsed.error.errors);
    const { accountName, accountNumber, ifsc } = parsed.data;
    const updated = await prisma.seller.update({
      where: { id: req.sellerId },
      data: { bankDetails: { accountName, accountNumber, ifsc } },
    });
    res.json({ success: true, data: shapeProfile(updated, await isAgreementCurrent(updated.id)) });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Onboarding KYC — submit for owner review + per-purpose consent (Phase 1) ─────
// SELLER_DELIVERY_ONBOARDING_PLAN.md. The draft itself is just the Seller row (edited via PUT /
// above); these two endpoints are the "submit" action and the consent-capture action.

const REQUIRED_ONBOARDING_FIELDS: Array<[keyof Awaited<ReturnType<typeof prisma.seller.findUniqueOrThrow>>, string]> = [
  ["gstin", "GSTIN"],
  ["pan", "PAN"],
  ["shopAddress", "Shop address"],
  ["grievanceOfficerName", "Grievance officer name"],
  ["grievanceOfficerPhone", "Grievance officer phone"],
];

router.post("/onboarding/submit", async (req: SellerRequest, res: Response) => {
  try {
    const seller = await prisma.seller.findUnique({ where: { id: req.sellerId } });
    if (!seller) throw new NotFoundError("Seller", req.sellerId ?? "");
    if (seller.onboardingStatus === "APPROVED") {
      return res.json({ success: true, data: shapeProfile(seller, await isAgreementCurrent(seller.id)) });
    }

    const missing = REQUIRED_ONBOARDING_FIELDS.filter(([field]) => {
      const v = (seller as any)[field];
      return v === null || v === undefined || v === "";
    }).map(([, label]) => label);
    // FSSAI is asked for but not hard-blocked at submit — Rule 6 requires the info exist and be
    // disclosed, not a specific enforcement mechanism (plan §7, left as an open decision for a
    // stricter Phase 2 gate if wanted). GSTIN/PAN/grievance officer ARE hard-required (Rule 6 is
    // unconditional on those).
    if (missing.length > 0) {
      throw new ValidationError(`Please complete: ${missing.join(", ")}`, missing);
    }

    const [hasAgreementConsent, hasSensitiveConsent] = await Promise.all([
      prisma.consentRecord.findFirst({
        where: {
          subjectType: "SELLER",
          subjectId: seller.id,
          consentType: "PARTNER_AGREEMENT",
          version: PARTNER_AGREEMENT_VERSION,
          granted: true,
        },
      }),
      prisma.consentRecord.findFirst({
        where: { subjectType: "SELLER", subjectId: seller.id, consentType: "SENSITIVE_DATA_PROCESSING", granted: true },
      }),
    ]);
    if (!hasAgreementConsent || !hasSensitiveConsent) {
      throw new ValidationError("Please accept the partner agreement and data-processing consent before submitting.");
    }

    const updated = await prisma.seller.update({
      where: { id: seller.id },
      data: { onboardingStatus: "PENDING_REVIEW", onboardingRejectionReason: null },
    });
    res.json({ success: true, data: shapeProfile(updated, true) });
  } catch (e) {
    sendError(res, e);
  }
});

const consentSchema = z.object({
  consentType: z.enum(["PARTNER_AGREEMENT", "SENSITIVE_DATA_PROCESSING", "LOCATION_TRACKING", "POLICE_VERIFICATION"]),
  version: z.string().min(1).max(60),
  granted: z.boolean().default(true),
});

router.post("/onboarding/consent", async (req: SellerRequest, res: Response) => {
  try {
    const parsed = consentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid consent data", parsed.error.errors);
    if (!req.sellerId) throw new NotFoundError("Seller", "");

    const record = await prisma.consentRecord.create({
      data: {
        subjectType: "SELLER",
        subjectId: req.sellerId,
        consentType: parsed.data.consentType,
        version: parsed.data.version,
        granted: parsed.data.granted,
      },
    });
    // Onboarding-status also flips NOT_STARTED→IN_PROGRESS on first real interaction, so the owner
    // queue can distinguish "hasn't looked at it" from "in progress."
    await prisma.seller.updateMany({
      where: { id: req.sellerId, onboardingStatus: "NOT_STARTED" },
      data: { onboardingStatus: "IN_PROGRESS" },
    });
    res.status(201).json({ success: true, data: { id: record.id, consentType: record.consentType, grantedAt: record.grantedAt } });
  } catch (e) {
    sendError(res, e);
  }
});

router.get("/onboarding/consent", async (req: SellerRequest, res: Response) => {
  try {
    if (!req.sellerId) throw new NotFoundError("Seller", "");
    const records = await prisma.consentRecord.findMany({
      where: { subjectType: "SELLER", subjectId: req.sellerId },
      orderBy: { grantedAt: "desc" },
    });
    res.json({
      success: true,
      data: records.map((r) => ({ id: r.id, consentType: r.consentType, version: r.version, granted: r.granted, grantedAt: r.grantedAt })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /earnings — gross / commission / net + payout history ────
router.get("/earnings", async (req: SellerRequest, res: Response) => {
  try {
    const seller = await prisma.seller.findUnique({
      where: { id: req.sellerId },
      select: { outstandingBalance: true, commissionPct: true },
    });
    if (!seller) throw new NotFoundError("Seller", req.sellerId ?? "");

    const [allTime, unsettled, payouts] = await Promise.all([
      prisma.subOrder.aggregate({ where: { sellerId: req.sellerId }, _sum: { subtotal: true, commissionAmount: true, tcsAmount: true, netPayable: true }, _count: true }),
      prisma.subOrder.aggregate({ where: { sellerId: req.sellerId, settled: false }, _sum: { netPayable: true }, _count: true }),
      prisma.sellerPayout.findMany({ where: { sellerId: req.sellerId }, orderBy: { paidAt: "desc" }, take: 20 }),
    ]);

    res.json({
      success: true,
      data: {
        commissionPct: Number(seller.commissionPct),
        outstandingBalance: Number(seller.outstandingBalance),
        orderCount: allTime._count,
        totalGross: Number(allTime._sum.subtotal ?? 0),
        totalCommission: Number(allTime._sum.commissionAmount ?? 0),
        // GST Sec-52 TCS the platform withholds (gross − commission − tcs = net). 0 until Phase 6.
        totalTcs: Number(allTime._sum.tcsAmount ?? 0),
        totalNet: Number(allTime._sum.netPayable ?? 0),
        unsettledCount: unsettled._count,
        unsettledNet: Number(unsettled._sum.netPayable ?? 0),
        payouts: payouts.map((p) => ({
          id: p.id,
          grossAmount: Number(p.grossAmount),
          commission: Number(p.commission),
          tcs: Number(p.tcs),
          netPaid: Number(p.netPaid),
          paidAt: p.paidAt,
          mode: p.mode,
          reference: p.reference,
          note: p.note,
        })),
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── GET /analytics — seller's own sales/inventory analytics (interactive charts) ──
// Scoped strictly to THIS seller (SubOrder.sellerId / OrderItem.sellerId), so it never leaks another
// seller's numbers. Mirrors the owner Analytics revamp's shapes 1:1 (RankedRow, IST-day bucketing)
// so the app reuses the same Vico chart components — but deliberately narrower: a shopkeeper needs
// "how's MY shop doing", not the platform-wide/cross-seller view the owner tab carries. No schema
// change (git-push only). Memoized 3 min per (seller, range) so a range-tap / tab-reopen doesn't
// re-hit Postgres on the single Render instance.
//
// "Revenue" here = GROSS sales (SubOrder.subtotal / OrderItem.lineTotal), NOT net-after-commission —
// it's the sales-performance signal; the take-home net stays in the money cards on the Earnings tab.
// All of it excludes CANCELLED (a cancelled slice isn't a sale).

const SELLER_ANALYTICS_TTL_MS = 3 * 60 * 1000;
const SELLER_VALID_RANGES = ["today", "week", "month", "quarter"];
const SELLER_RANGE_DAYS: Record<string, number> = { week: 7, month: 30, quarter: 90 };

// IST = UTC+5:30. Every timestamp is stored naive-UTC and Render runs in UTC, so "today" must be
// computed off IST midnight, not the process's UTC midnight (same reasoning + helper as
// ownerAnalytics.ts — see the long comment there).
const SELLER_IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function sellerIstMidnightUtc(now: Date): Date {
  const shifted = new Date(now.getTime() + SELLER_IST_OFFSET_MS);
  const dayStartShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(dayStartShifted - SELLER_IST_OFFSET_MS);
}

function sellerRangeSince(range: string): Date {
  const now = new Date();
  if (range === "today") return sellerIstMidnightUtc(now);
  const days = SELLER_RANGE_DAYS[range] ?? SELLER_RANGE_DAYS.month;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function sellerRupees(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

// The bucket values come back with the IST shift already baked in (the AT TIME ZONE query below),
// so format them by their UTC calendar getters explicitly (don't rely on the process TZ).
function sellerBucketLabel(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

interface SellerRankedRow {
  id: string;
  label: string;
  value: number;
  displayValue: string;
  sublabel?: string;
}

interface SellerTrendRow {
  bucket: Date;
  revenue: number | null;
  orders: number | null;
}

async function buildSellerAnalytics(sellerId: string, range: string) {
  const since = sellerRangeSince(range);
  const durationMs = Date.now() - since.getTime();
  const prevSince = new Date(since.getTime() - durationMs); // equal-length window ending where current begins
  const bucketUnit: "day" | "week" = range === "today" || range === "week" ? "day" : "week";

  const [trendRows, currentAgg, prevAgg, topProductsRaw, unitsByVariant, activeProducts] =
    await Promise.all([
      // Sales trend — gross subtotal + sub-order count per IST calendar day/week. bucketUnit is
      // chosen from a 2-value whitelist (never taken from req.query) and still passed as a bound
      // param; sellerId is a bound param too.
      prisma.$queryRaw<SellerTrendRow[]>`
        SELECT date_trunc(${bucketUnit}, "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') as bucket,
               SUM("subtotal")::float as revenue,
               COUNT(*)::int as orders
        FROM "SubOrder"
        WHERE "sellerId" = ${sellerId} AND status != 'CANCELLED' AND "createdAt" >= ${since}
        GROUP BY bucket
        ORDER BY bucket ASC`,
      prisma.subOrder.aggregate({
        _sum: { subtotal: true },
        _count: true,
        where: { sellerId, status: { not: "CANCELLED" }, createdAt: { gte: since } },
      }),
      prisma.subOrder.aggregate({
        _sum: { subtotal: true },
        _count: true,
        where: { sellerId, status: { not: "CANCELLED" }, createdAt: { gte: prevSince, lt: since } },
      }),
      // Top products by gross revenue. Grouped by the item's snapshot productName (a clean label with
      // no variant→product join needed); these rows aren't tap-to-drill in the seller tab, same as the
      // owner's agent/seller rows, so the name doubling as the id is harmless.
      prisma.orderItem.groupBy({
        by: ["productName"],
        _sum: { lineTotal: true, quantity: true },
        where: { sellerId, order: { status: { not: "CANCELLED" }, createdAt: { gte: since } } },
        orderBy: { _sum: { lineTotal: "desc" } },
        take: 8,
      }),
      // Units sold per variant in the window (for the inventory-health rollup below).
      prisma.orderItem.groupBy({
        by: ["variantId"],
        _sum: { quantity: true },
        where: {
          sellerId,
          variantId: { not: null },
          order: { status: { not: "CANCELLED" }, createdAt: { gte: since } },
        },
      }),
      // This seller's own active catalog (dead-stock / restock is scoped to their products only).
      prisma.catalogProduct.findMany({
        where: { isActive: true, sellerId },
        select: {
          id: true,
          name: true,
          variants: { where: { isActive: true }, select: { id: true, stock: true, sellingPrice: true } },
        },
      }),
    ]);

  // ── Summary (current period + previous period → the ▲/▼% delta) ──
  const revenue = Number(currentAgg._sum.subtotal ?? 0);
  const orders = currentAgg._count;
  const prevRevenue = Number(prevAgg._sum.subtotal ?? 0);
  const prevOrders = prevAgg._count;
  const avgOrderValue = orders > 0 ? revenue / orders : 0;
  // null when there's no prior baseline — the app shows "new" instead of a misleading +100%/∞.
  const revenueDeltaPct = prevRevenue > 0 ? ((revenue - prevRevenue) / prevRevenue) * 100 : null;

  // ── Trend series (both metrics; the app toggles Revenue⇄Orders on the same chart) ──
  const trend = trendRows.map((r) => ({
    label: sellerBucketLabel(new Date(r.bucket)),
    revenue: Number(r.revenue ?? 0),
    orders: Number(r.orders ?? 0),
  }));

  // ── Top products ──
  const topProducts: SellerRankedRow[] = topProductsRaw
    .filter((r) => Number(r._sum.lineTotal ?? 0) > 0)
    .map((r) => ({
      id: r.productName,
      label: r.productName,
      value: Number(r._sum.lineTotal ?? 0),
      displayValue: sellerRupees(Number(r._sum.lineTotal ?? 0)),
      sublabel: `${Number(r._sum.quantity ?? 0)} sold`,
    }));

  // ── Inventory health: roll variant units/stock up to the parent product ──
  const unitsByVariantMap = new Map<string, number>(
    unitsByVariant.map((r) => [r.variantId as string, Number(r._sum.quantity ?? 0)])
  );
  interface PAgg { id: string; name: string; units: number; stock: number; stockValue: number }
  const products: PAgg[] = activeProducts.map((p) => {
    let units = 0, stock = 0, stockValue = 0;
    for (const v of p.variants) {
      const u = unitsByVariantMap.get(v.id) ?? 0;
      const s = Number(v.stock);
      units += u;
      stock += s;
      stockValue += s * Number(v.sellingPrice);
    }
    return { id: p.id, name: p.name, units, stock, stockValue };
  });

  // Dead stock — in stock but zero orders this window, ranked by ₹ tied up (biggest opportunity first).
  const deadStock: SellerRankedRow[] = products
    .filter((p) => p.units === 0 && p.stock > 0)
    .sort((a, b) => b.stockValue - a.stockValue)
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      label: p.name,
      value: p.stockValue,
      displayValue: `${sellerRupees(p.stockValue)} tied up`,
      sublabel: `${p.stock} in stock, 0 sold`,
    }));

  // Restock priority — high units sold relative to what's left; about to run out.
  const restockPriority: SellerRankedRow[] = products
    .filter((p) => p.units > 0 && p.stock > 0)
    .map((p) => ({ ...p, ratio: p.units / p.stock }))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      label: p.name,
      value: p.ratio,
      displayValue: `${p.stock} left`,
      sublabel: `${p.units} sold this window`,
    }));

  return {
    range,
    since: since.toISOString(),
    summary: { revenue, orders, avgOrderValue, prevRevenue, prevOrders, revenueDeltaPct },
    trend,
    topProducts,
    deadStock,
    restockPriority,
  };
}

router.get("/analytics", async (req: SellerRequest, res: Response) => {
  try {
    const sellerId = req.sellerId as string;
    const requested = String(req.query.range ?? "month");
    const range = SELLER_VALID_RANGES.includes(requested) ? requested : "month";
    const data = await memoCache.get(
      `sellerAnalytics:${sellerId}:${range}`,
      SELLER_ANALYTICS_TTL_MS,
      () => buildSellerAnalytics(sellerId, range)
    );
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
