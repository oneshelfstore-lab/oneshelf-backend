import { Router, type Response } from "express";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import {
  freeGiftOfferSchema,
  listFreeGiftOffers,
  createFreeGiftOfferRecord,
  updateFreeGiftOfferRecord,
  deleteFreeGiftOfferRecord,
} from "../services/freeGifts.js";

// ═══════════════════════════════════════════════════════════════════════
// Seller router (Firebase auth, mounted at /api/app/seller/free-gifts)
// ═══════════════════════════════════════════════════════════════════════
//
// Same "buy N, get M free" CRUD as routes/ownerFreeGifts.ts, gated to the HOUSE co-manager only
// (third-party sellers can't create these — see FreeGiftOffer's schema.prisma doc comment: giving
// away a third-party seller's product for free has no payout/commission story yet). Mirrors
// sellerCatalog.ts's "POST /categories — HOUSE co-manager only" precedent rather than widening the
// owner router's auth, since a SELLER-role request needs resolveSeller (which an OWNER-role request
// never has) to even know whether it's the house account.

export const sellerFreeGiftRouter = Router();
sellerFreeGiftRouter.use(firebaseAuthMiddleware as any);
sellerFreeGiftRouter.use(requireAppRole("SELLER") as any);
sellerFreeGiftRouter.use(resolveSeller as any);

function requireHouse(req: SellerRequest, res: Response): boolean {
  if (req.sellerIsHouse !== true) {
    res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Only the store's house manager can manage free-gift offers", details: [] },
    });
    return false;
  }
  return true;
}

// GET / — list all offers (incl. inactive).
sellerFreeGiftRouter.get("/", async (req: SellerRequest, res: Response) => {
  if (!requireHouse(req, res)) return;
  try {
    const offers = await listFreeGiftOffers();
    res.json({ success: true, data: offers });
  } catch (e) {
    sendError(res, e);
  }
});

// POST / — create an offer.
sellerFreeGiftRouter.post("/", async (req: SellerRequest, res: Response) => {
  if (!requireHouse(req, res)) return;
  try {
    const parsed = freeGiftOfferSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid free-gift offer", parsed.error.errors);
    const offer = await createFreeGiftOfferRecord(parsed.data);
    res.status(201).json({ success: true, data: offer });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /:id — update an offer.
sellerFreeGiftRouter.put("/:id", async (req: SellerRequest, res: Response) => {
  if (!requireHouse(req, res)) return;
  try {
    const parsed = freeGiftOfferSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid free-gift offer", parsed.error.errors);
    const offer = await updateFreeGiftOfferRecord(req.params.id as string, parsed.data);
    res.json({ success: true, data: offer });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /:id — hard delete (this is just a promo config, not user/order data).
sellerFreeGiftRouter.delete("/:id", async (req: SellerRequest, res: Response) => {
  if (!requireHouse(req, res)) return;
  try {
    await deleteFreeGiftOfferRecord(req.params.id as string);
    res.json({ success: true, message: "Free-gift offer removed" });
  } catch (e) {
    sendError(res, e);
  }
});
