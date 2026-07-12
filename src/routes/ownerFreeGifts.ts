import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { memoCache } from "../lib/httpCache.js";

// ═══════════════════════════════════════════════════════════════════════
// Owner router (Firebase auth, mounted at /api/app/owner/free-gifts)
// ═══════════════════════════════════════════════════════════════════════
//
// "Buy N of X, get M of Y free" promotional bundles (the classic distributor freebie — e.g. a
// supplier's "1kg free with a 10kg basmati bag"). v1 restriction: BOTH the trigger and the reward
// must be HOUSE-catalog products — giving away a third-party seller's product for free has no
// payout/commission story yet (out of scope). See schema.prisma's FreeGiftOffer doc comment.

export const ownerFreeGiftRouter = Router();
ownerFreeGiftRouter.use(firebaseAuthMiddleware as any);
ownerFreeGiftRouter.use(requireAppRole("OWNER") as any);

const freeGiftSchema = z.object({
  triggerVariantId: z.string().min(1),
  triggerQty: z.number().int().min(1).max(999),
  rewardVariantId: z.string().min(1),
  rewardQty: z.number().int().min(1).max(999),
  isActive: z.boolean().default(true),
});

const include = {
  triggerVariant: { select: { id: true, sku: true, packageSize: true, packageUnit: true, product: { select: { name: true, imageUrls: true } } } },
  rewardVariant: { select: { id: true, sku: true, packageSize: true, packageUnit: true, product: { select: { name: true, imageUrls: true } } } },
} as const;

/** Both variants must exist, be distinct, and belong to the HOUSE catalog (null sellerId ⇒ a
 *  pre-backfill/legacy product, treated as house everywhere else in this codebase too). */
async function validateVariantPair(triggerVariantId: string, rewardVariantId: string): Promise<void> {
  if (triggerVariantId === rewardVariantId) {
    throw new ValidationError("The reward can't be the same product as the trigger.");
  }
  const [trigger, reward] = await Promise.all([
    prisma.productVariant.findUnique({
      where: { id: triggerVariantId },
      select: { id: true, product: { select: { sellerId: true, seller: { select: { isHouse: true } } } } },
    }),
    prisma.productVariant.findUnique({
      where: { id: rewardVariantId },
      select: { id: true, product: { select: { sellerId: true, seller: { select: { isHouse: true } } } } },
    }),
  ]);
  if (!trigger) throw new NotFoundError("Product variant", triggerVariantId);
  if (!reward) throw new NotFoundError("Product variant", rewardVariantId);

  const isHouse = (v: typeof trigger) => v.product.sellerId == null || v.product.seller?.isHouse === true;
  if (!isHouse(trigger) || !isHouse(reward)) {
    throw new ValidationError("Free-gift offers only work between the store's own (house) products for now.");
  }
}

// GET / — list all offers (incl. inactive) for the owner manager.
ownerFreeGiftRouter.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const offers = await prisma.freeGiftOffer.findMany({ include, orderBy: { createdAt: "desc" } });
    res.json({ success: true, data: offers });
  } catch (e) {
    sendError(res, e);
  }
});

// POST / — create an offer.
ownerFreeGiftRouter.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = freeGiftSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid free-gift offer", parsed.error.errors);
    const { triggerVariantId, rewardVariantId } = parsed.data;

    await validateVariantPair(triggerVariantId, rewardVariantId);

    const existing = await prisma.freeGiftOffer.findUnique({ where: { triggerVariantId } });
    if (existing) throw new ConflictError("This product already has a free-gift offer — edit or delete it instead.");

    const offer = await prisma.freeGiftOffer.create({ data: parsed.data, include });
    memoCache.bust("freeGiftOffers");
    res.status(201).json({ success: true, data: offer });
  } catch (e) {
    sendError(res, e);
  }
});

// PUT /:id — update an offer.
ownerFreeGiftRouter.put("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const existingOffer = await prisma.freeGiftOffer.findUnique({ where: { id: req.params.id } });
    if (!existingOffer) throw new NotFoundError("Free-gift offer", req.params.id!);

    const parsed = freeGiftSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid free-gift offer", parsed.error.errors);

    const triggerVariantId = parsed.data.triggerVariantId ?? existingOffer.triggerVariantId;
    const rewardVariantId = parsed.data.rewardVariantId ?? existingOffer.rewardVariantId;
    await validateVariantPair(triggerVariantId, rewardVariantId);

    if (triggerVariantId !== existingOffer.triggerVariantId) {
      const dup = await prisma.freeGiftOffer.findUnique({ where: { triggerVariantId } });
      if (dup) throw new ConflictError("This product already has a free-gift offer — edit or delete it instead.");
    }

    const offer = await prisma.freeGiftOffer.update({ where: { id: req.params.id }, data: parsed.data, include });
    memoCache.bust("freeGiftOffers");
    res.json({ success: true, data: offer });
  } catch (e) {
    sendError(res, e);
  }
});

// DELETE /:id — hard delete (this is just a promo config, not user/order data).
ownerFreeGiftRouter.delete("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const existing = await prisma.freeGiftOffer.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError("Free-gift offer", req.params.id!);

    await prisma.freeGiftOffer.delete({ where: { id: req.params.id } });
    memoCache.bust("freeGiftOffers");
    res.json({ success: true, message: "Free-gift offer removed" });
  } catch (e) {
    sendError(res, e);
  }
});
