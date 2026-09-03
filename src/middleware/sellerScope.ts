import type { Response, NextFunction } from "express";
import prisma from "../lib/prisma.js";
import { type FirebaseAuthRequest } from "./firebaseAuth.js";

export interface SellerRequest extends FirebaseAuthRequest {
  sellerId?: string;
  // True when the logged-in seller IS the house store (the owner's own catalog). The house manager
  // gets extra powers third-party sellers don't: products go live immediately + owner-only
  // merchandising toggles (₹99 store / free-sample / visibility).
  sellerIsHouse?: boolean;
  // Which business this seller trades in: "SHOP" (grocery) | "FOOD" (restaurant). Pinned here
  // rather than re-queried per router so a food-only route (menu editing) can gate on it without a
  // second round-trip, and so a SHOP seller can never reach the menu editor.
  sellerVertical?: string;
}

/**
 * Resolves the caller's Seller (by ownerUserId) and pins `req.sellerId`. MUST run AFTER
 * firebaseAuthMiddleware + requireAppRole("SELLER"). Every /api/app/seller/* query then
 * hard-filters `WHERE sellerId = req.sellerId`, so a seller can only ever touch their own data.
 * Blocks suspended / deactivated / unlinked sellers.
 */
export async function resolveSeller(req: SellerRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.appUser?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated", details: [] } });
    }
    const seller = await prisma.seller.findUnique({
      where: { ownerUserId: userId },
      select: { id: true, status: true, isActive: true, isHouse: true, vertical: true },
    });
    if (!seller) {
      return res.status(403).json({ success: false, error: { code: "NO_SELLER", message: "No seller account is linked to this login", details: [] } });
    }
    if (seller.status === "SUSPENDED" || !seller.isActive) {
      return res.status(403).json({ success: false, error: { code: "SELLER_SUSPENDED", message: "This seller account is suspended", details: [] } });
    }
    req.sellerId = seller.id;
    req.sellerIsHouse = seller.isHouse;
    req.sellerVertical = seller.vertical;
    next();
  } catch (e) {
    console.error("resolveSeller error:", e);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Failed to resolve seller", details: [] } });
  }
}
