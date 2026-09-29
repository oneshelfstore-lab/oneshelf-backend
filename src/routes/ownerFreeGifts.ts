import { Router, type Response } from "express";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import {
  freeGiftOfferSchema,
  listFreeGiftOffers,
  createFreeGiftOfferRecord,
  updateFreeGiftOfferRecord,
  deleteFreeGiftOfferRecord,
} from "../services/freeGifts.js";

// ═══════════════════════════════════════════════════════════════════════
// Owner router (Firebase auth, mounted at /api/app/owner/free-gifts)
// ═══════════════════════════════════════════════════════════════════════
//
// "Buy N of X, get M of Y free" promotional bundles (the classic distributor freebie — e.g. a
// supplier's "1kg free with a 10kg basmati bag"). v1 restriction: BOTH the trigger and the reward
// must be HOUSE-catalog products — giving away a third-party seller's product for free has no
// payout/commission story yet (out of scope). See schema.prisma's FreeGiftOffer doc comment.
// The house co-manager gets the same CRUD via routes/sellerFreeGifts.ts — both routers call the
// same services/freeGifts.ts record functions, so the two admin surfaces can never drift.

export const ownerFreeGiftRouter = Router();
ownerFreeGiftRouter.use(firebaseAuthMiddleware as any);
ownerFreeGiftRouter.use(requireAppRole("OWNER") as any);

// GET / — list all offers (incl. inactive) for the owner manager.
ownerFreeGiftRouter.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const offers = await listFreeGiftOffers();
    res.json({ success: true, data: offers });
  } catch (e) {
    sendError(res, e);
  }
});

// POST / — create an offer.
ownerFreeGiftRouter.post("/", async (req: FirebaseAuthRequest, res: Response) => {
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
ownerFreeGiftRouter.put("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = freeGiftOfferSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid free-gift offer", parsed.error.errors);
    const offer = await updateFreeGiftOfferRecord(String(req.params.id), parsed.data);
    res.json({ success: true, data: offer });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /:id — hard delete (this is just a promo config, not user/order data).
ownerFreeGiftRouter.delete("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    await deleteFreeGiftOfferRecord(String(req.params.id));
    res.json({ success: true, message: "Free-gift offer removed" });
  } catch (e) {
    sendError(res, e);
  }
});
