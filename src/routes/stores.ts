import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { haversineKm } from "../lib/distance.js";
import { cacheControl } from "../lib/httpCache.js";
import { computeDistanceDelivery } from "../services/deliveryPricing.js";

// Public, no auth, mounted at /api/app/stores. The customer-facing list of shops on the marketplace
// (the house store first). Deliberately NO rating and NO delivery time: neither exists as real data
// yet, and a made-up "4.6 · 20 min" is the fake-ETA mistake this app has already refused once.
export const publicStoresRouter = Router();

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

const round1 = (n: number) => Math.round(n * 10) / 10;

/** What delivery costs THIS customer, from the store-wide slabs. Same calc the cart quote uses. */
async function feeForYou(lat?: number, lng?: number) {
  const [cfg, del] = await Promise.all([
    prisma.storeConfig.findFirst({
      select: {
        deliveryCharge: true, freeDeliveryAbove: true, minOrderValue: true,
        noDeliveryCharge: true, isOrderingAllowed: true,
      },
    }),
    computeDistanceDelivery(lat ?? null, lng ?? null),
  ]);
  return {
    deliveryFee: cfg?.noDeliveryCharge ? 0 : del.charge ?? Number(cfg?.deliveryCharge ?? 0),
    freeDeliveryAbove: cfg?.noDeliveryCharge ? 0 : Number(cfg?.freeDeliveryAbove ?? 0),
    minOrder: Number(cfg?.minOrderValue ?? 0),
    outOfRange: del.outOfRange,
    orderingPaused: cfg?.isOrderingAllowed === false,
  };
}

const distanceTo = (
  lat: number | undefined, lng: number | undefined, sLat: unknown, sLng: unknown,
): number | null =>
  lat != null && lng != null && sLat != null && sLng != null
    ? round1(haversineKm(lat, lng, Number(sLat), Number(sLng)))
    : null;

publicStoresRouter.get("/", cacheControl(30), async (req: Request, res: Response) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid query", parsed.error.errors);
    const { lat, lng } = parsed.data;

    const [sellers, fee] = await Promise.all([
      prisma.seller.findMany({
        // Shops only: restaurants live in the Food vertical. Suspended/inactive shops are not shown.
        where: { isActive: true, status: "APPROVED", vertical: "SHOP" },
        select: {
          id: true, name: true, logoUrl: true, coverUrl: true, isHouse: true,
          lat: true, lng: true, closedSince: true, city: true,
        },
      }),
      feeForYou(lat, lng),
    ]);

    const stores = sellers
      .map((s) => ({
        id: s.id,
        name: s.name,
        imageUrl: s.coverUrl ?? s.logoUrl ?? null,
        isHouse: s.isHouse,
        isOpen: s.closedSince == null,
        distanceKm: distanceTo(lat, lng, s.lat, s.lng),
        deliveryFee: fee.deliveryFee,
        freeDeliveryAbove: fee.freeDeliveryAbove,
        minOrder: fee.minOrder,
      }))
      // House store is always card #1, then nearest first (unknown distance last).
      .sort((a, b) =>
        a.isHouse !== b.isHouse ? (a.isHouse ? -1 : 1) : (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
      );

    res.json({ success: true, data: stores });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/app/stores/:id?lat&lng — the storefront header: everything the page needs before the catalogue.
publicStoresRouter.get("/:id", cacheControl(30), async (req: Request, res: Response) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid query", parsed.error.errors);
    const { lat, lng } = parsed.data;
    const id = String(req.params.id ?? "");

    const s = await prisma.seller.findFirst({
      where: { id, isActive: true, status: "APPROVED", vertical: "SHOP" },
      select: {
        id: true, name: true, logoUrl: true, coverUrl: true, isHouse: true, lat: true, lng: true,
        shopAddress: true, city: true, pincode: true, phone: true, openTime: true, closeTime: true,
        closedSince: true,
      },
    });
    if (!s) throw new NotFoundError("Store", id);

    // Popular = what customers actually ordered from this shop in the last 30 days (cancelled orders
    // excluded). No history yet means an empty list, and the app falls back to the newest products.
    // The house shop's items carry sellerId null on the catalogue side, so match its order lines by
    // either its own id or a null sellerId.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const lines = await prisma.orderItem.groupBy({
      by: ["variantId"],
      where: {
        variantId: { not: null },
        order: { status: { not: "CANCELLED" }, createdAt: { gte: since } },
        ...(s.isHouse ? { OR: [{ sellerId: s.id }, { sellerId: null }] } : { sellerId: s.id }),
      },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 12,
    });
    const variantIds = lines.map((l) => l.variantId!).filter(Boolean);
    const variants = variantIds.length
      ? await prisma.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true, productId: true } })
      : [];
    const byVariant = new Map(variants.map((v) => [v.id, v.productId]));
    const popularProductIds = [...new Set(variantIds.map((v) => byVariant.get(v)).filter((x): x is string => !!x))];

    const fee = await feeForYou(lat, lng);

    res.json({
      success: true,
      data: {
        id: s.id,
        name: s.name,
        imageUrl: s.coverUrl ?? s.logoUrl ?? null,
        isHouse: s.isHouse,
        isOpen: s.closedSince == null,
        distanceKm: distanceTo(lat, lng, s.lat, s.lng),
        address: [s.shopAddress, s.city, s.pincode].filter(Boolean).join(", ") || null,
        lat: s.lat != null ? Number(s.lat) : null,
        lng: s.lng != null ? Number(s.lng) : null,
        phone: s.phone,
        // Display-only: hours never open or close the shop (only the seller's Open/Closed switch does).
        openTime: s.openTime,
        closeTime: s.closeTime,
        ...fee,
        popularProductIds,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
});
