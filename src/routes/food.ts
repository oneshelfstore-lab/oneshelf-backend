import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, NotFoundError } from "../lib/errors.js";
import { cacheControl } from "../lib/httpCache.js";
import { haversineKm } from "../lib/distance.js";
import { resolveFoodConfig, isRestaurantOpen, RESTAURANT_TRADING } from "../services/foodMenu.js";

/**
 * Customer-facing food browse. Mounted PUBLICLY at /api/app/food, alongside the grocery catalog —
 * a customer browses restaurants before signing in, same as they browse products.
 *
 * Browse is restaurant-first, not dish-first: list → restaurant → menu. Two endpoints cover it.
 */
const router = Router();

const BROWSE_TTL_SECONDS = 30;

function toNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Open restaurants, nearest first when the caller passes ?lat=&lng=.
 *
 * ⚠️ Returns an EMPTY list (not a 404 or an error) while StoreConfig.foodEnabled is off. That's the
 * CA gate doing its job — the vertical is fully built but must not trade until the Sec 9(5) position
 * is signed off (MULTIVERTICAL_PLAN.md §4.4). An empty list degrades to "no restaurants yet" on the
 * client, which is honest and needs no special-casing there.
 */
router.get("/restaurants", cacheControl(BROWSE_TTL_SECONDS), async (req: Request, res: Response) => {
  try {
    const cfg = await resolveFoodConfig();
    if (!cfg.enabled) return res.json({ success: true, data: [] });

    const lat = toNum(req.query.lat);
    const lng = toNum(req.query.lng);

    const rows = await prisma.seller.findMany({
      where: RESTAURANT_TRADING,
      select: {
        id: true, name: true, slug: true, logoUrl: true, cuisines: true,
        openTime: true, closeTime: true, avgPrepMinutes: true, minOrderValue: true,
        lat: true, lng: true, shopAddress: true, city: true,
      },
    });

    // isOpen is computed per REQUEST, never cached with the row — the response is Cache-Control'd
    // for 30s, so baking a stale open/closed flag into a memo would let a closed kitchen keep
    // taking orders.
    const now = new Date();
    const shaped = rows.map((r) => {
      const rLat = r.lat != null ? Number(r.lat) : null;
      const rLng = r.lng != null ? Number(r.lng) : null;
      const distanceKm =
        lat != null && lng != null && rLat != null && rLng != null
          ? round1(haversineKm(lat, lng, rLat, rLng))
          : null;
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        logoUrl: r.logoUrl,
        cuisines: (r.cuisines ?? "").split(",").map((c) => c.trim()).filter(Boolean),
        isOpen: isRestaurantOpen(r.openTime, r.closeTime, now),
        openTime: r.openTime,
        closeTime: r.closeTime,
        avgPrepMinutes: r.avgPrepMinutes,
        minOrderValue: Number(r.minOrderValue),
        distanceKm,
        address: r.shopAddress,
        city: r.city,
      };
    });

    // Open first, then nearest (unknown distance sinks to the bottom of its group rather than
    // sorting as 0 and jumping to the top).
    shaped.sort((a, b) => {
      if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
      const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
      const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name);
    });

    res.json({ success: true, data: shaped });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * One restaurant + its live menu.
 *
 * ⚠️ Filters isActive but NOT isAvailable — an 86'd dish is RETURNED with `isAvailable: false` so
 * the client can grey it out in place. Hiding it instead makes a menu look different every visit
 * and loses the "sold out, back tomorrow" signal customers actually want.
 */
router.get("/restaurants/:id", cacheControl(BROWSE_TTL_SECONDS), async (req: Request, res: Response) => {
  try {
    const cfg = await resolveFoodConfig();
    if (!cfg.enabled) throw new NotFoundError("Restaurant", String(req.params.id ?? ""));

    const id = String(req.params.id ?? "");
    const seller = await prisma.seller.findFirst({
      where: { id, ...RESTAURANT_TRADING },
      select: {
        id: true, name: true, slug: true, logoUrl: true, cuisines: true, phone: true,
        openTime: true, closeTime: true, avgPrepMinutes: true, minOrderValue: true,
        lat: true, lng: true, shopAddress: true, city: true,
        fssaiNumber: true,
        // Rule 6 (Consumer Protection E-Commerce Rules) disclosure, same as the grocery listing.
        grievanceOfficerName: true, grievanceOfficerPhone: true,
        menuCategories: {
          where: { isActive: true },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: {
            id: true, name: true, sortOrder: true,
            items: {
              where: { isActive: true },
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              select: {
                id: true, name: true, description: true, imageUrl: true, price: true,
                isVeg: true, isAvailable: true, prepMinutes: true,
              },
            },
          },
        },
      },
    });
    if (!seller) throw new NotFoundError("Restaurant", String(req.params.id ?? ""));

    res.json({
      success: true,
      data: {
        id: seller.id,
        name: seller.name,
        slug: seller.slug,
        logoUrl: seller.logoUrl,
        cuisines: (seller.cuisines ?? "").split(",").map((c) => c.trim()).filter(Boolean),
        phone: seller.phone,
        isOpen: isRestaurantOpen(seller.openTime, seller.closeTime, new Date()),
        openTime: seller.openTime,
        closeTime: seller.closeTime,
        avgPrepMinutes: seller.avgPrepMinutes,
        minOrderValue: Number(seller.minOrderValue),
        address: seller.shopAddress,
        city: seller.city,
        lat: seller.lat != null ? Number(seller.lat) : null,
        lng: seller.lng != null ? Number(seller.lng) : null,
        fssaiNumber: seller.fssaiNumber,
        grievanceOfficerName: seller.grievanceOfficerName,
        grievanceOfficerPhone: seller.grievanceOfficerPhone,
        // Empty categories are dropped — a section header with nothing under it is noise on a menu.
        categories: seller.menuCategories
          .filter((c) => c.items.length > 0)
          .map((c) => ({
            id: c.id,
            name: c.name,
            items: c.items.map((i) => ({
              id: i.id,
              name: i.name,
              description: i.description,
              imageUrl: i.imageUrl,
              price: Number(i.price),
              isVeg: i.isVeg,
              isAvailable: i.isAvailable,
              prepMinutes: i.prepMinutes,
            })),
          })),
      },
    });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
