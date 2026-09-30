import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";
import { haversineKm } from "../lib/distance.js";
import { cacheControl } from "../lib/httpCache.js";

// Public, no auth, mounted at /api/app/stores. The customer-facing list of shops on the marketplace
// (the house store first). Deliberately NO rating and NO delivery time: neither exists as real data
// yet, and a made-up "4.6 · 20 min" is the fake-ETA mistake this app has already refused once.
export const publicStoresRouter = Router();

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

publicStoresRouter.get("/", cacheControl(30), async (req: Request, res: Response) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid query", parsed.error.errors);
    const { lat, lng } = parsed.data;

    const [sellers, cfg] = await Promise.all([
      prisma.seller.findMany({
        // Shops only: restaurants live in the Food vertical. Suspended/inactive shops are not shown.
        where: { isActive: true, status: "APPROVED", vertical: "SHOP" },
        select: {
          id: true, name: true, logoUrl: true, coverUrl: true, isHouse: true,
          lat: true, lng: true, closedSince: true, city: true,
        },
      }),
      prisma.storeConfig.findFirst({
        select: { deliveryCharge: true, freeDeliveryAbove: true, minOrderValue: true },
      }),
    ]);

    const deliveryFee = Number(cfg?.deliveryCharge ?? 0);
    const freeAbove = Number(cfg?.freeDeliveryAbove ?? 0);
    const minOrder = Number(cfg?.minOrderValue ?? 0);

    const stores = sellers
      .map((s) => {
        const distanceKm =
          lat != null && lng != null && s.lat != null && s.lng != null
            ? Math.round(haversineKm(lat, lng, Number(s.lat), Number(s.lng)) * 10) / 10
            : null;
        return {
          id: s.id,
          name: s.name,
          imageUrl: s.coverUrl ?? s.logoUrl ?? null,
          isHouse: s.isHouse,
          isOpen: s.closedSince == null,
          distanceKm,
          deliveryFee,
          freeDeliveryAbove: freeAbove,
          minOrder,
        };
      })
      // House store is always card #1, then nearest first (unknown distance last).
      .sort((a, b) =>
        a.isHouse !== b.isHouse ? (a.isHouse ? -1 : 1) : (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
      );

    res.json({ success: true, data: stores });
  } catch (err) {
    sendError(res, err);
  }
});
