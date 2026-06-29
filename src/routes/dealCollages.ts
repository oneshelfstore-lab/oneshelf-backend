import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { cacheControl, memoCache, PUBLIC_TTL_MS, PUBLIC_TTL_SECONDS } from "../lib/httpCache.js";

// ─── Deal collage (editable grid banner) ─────────────────────────────
//
// The "dynamic look" banner: a gradient sponsor header + a grid of editable product-area cards +
// a CTA footer. Owner-managed (Firebase auth, like ownerBanner/ownerCatalog); the customer Home
// reads it from the public router and renders the grid below the single-image banner carousel.

const orderCards = { cards: { orderBy: { displayOrder: "asc" as const } } };

// ─── Public router (no auth, mounted at /api/app/deal-collages) ───────

export const publicDealCollageRouter = Router();

publicDealCollageRouter.get("/", cacheControl(PUBLIC_TTL_SECONDS), async (req: Request, res: Response) => {
  try {
    const placement = typeof req.query.placement === "string" ? req.query.placement : undefined;
    const data = await memoCache.get(`deal-collages:${placement ?? "all"}`, PUBLIC_TTL_MS, async () =>
      prisma.dealCollage.findMany({
        where: { isActive: true, ...(placement ? { placement } : {}) },
        orderBy: { displayOrder: "asc" },
        include: orderCards,
      })
    );
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Owner router (FIREBASE auth, mounted at /api/app/owner/deal-collages) ──

export const ownerDealCollageRouter = Router();
ownerDealCollageRouter.use(firebaseAuthMiddleware as any);
ownerDealCollageRouter.use(requireAppRole("OWNER") as any);

const collageSchema = z.object({
  title: z.string().max(120).default(""),
  placement: z.enum(["HOME", "CATEGORY"]).default("HOME"),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().min(0).default(0),
  sponsorLabel: z.string().max(60).default("PRESENTED BY"),
  sponsorName: z.string().max(80).default(""),
  bgFrom: z.string().max(20).default("#6b8cde"),
  bgTo: z.string().max(20).default("#a8b8f0"),
  headerImageUrl: z.string().max(500).optional().nullable(),
  ctaText: z.string().max(120).default(""),
  ctaSubtext: z.string().max(120).default(""),
  ctaEmoji: z.string().max(16).default("🛒"),
  ctaTargetCategory: z.string().max(60).optional().nullable(),
  ctaTargetProduct: z.string().max(60).optional().nullable(),
});

const cardSchema = z.object({
  title: z.string().max(120).default(""),
  price: z.string().max(60).default(""),
  originalPrice: z.string().max(60).optional().nullable(),
  emoji: z.string().max(16).default("🛍️"),
  imageUrl: z.string().max(500).optional().nullable(),
  bgColor: z.string().max(20).default("#eef1ff"),
  featured: z.boolean().default(false),
  targetCategory: z.string().max(60).optional().nullable(),
  targetProduct: z.string().max(60).optional().nullable(),
  displayOrder: z.number().int().min(0).default(0),
});

ownerDealCollageRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const data = await prisma.dealCollage.findMany({
      orderBy: { displayOrder: "asc" },
      include: orderCards,
    });
    res.json({ success: true, data });
  } catch (e) {
    sendError(res, e);
  }
});

ownerDealCollageRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = collageSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid collage data", parsed.error.errors);
    const collage = await prisma.dealCollage.create({ data: parsed.data, include: orderCards });
    memoCache.bust("deal-collages");
    res.status(201).json({ success: true, data: collage });
  } catch (e) {
    sendError(res, e);
  }
});

ownerDealCollageRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.dealCollage.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("DealCollage", id);
    const parsed = collageSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid collage data", parsed.error.errors);
    const collage = await prisma.dealCollage.update({
      where: { id },
      data: parsed.data,
      include: orderCards,
    });
    memoCache.bust("deal-collages");
    res.json({ success: true, data: collage });
  } catch (e) {
    sendError(res, e);
  }
});

ownerDealCollageRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.dealCollage.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("DealCollage", id);
    await prisma.dealCollage.delete({ where: { id } }); // cascades to cards
    memoCache.bust("deal-collages");
    res.json({ success: true, message: "Collage deleted" });
  } catch (e) {
    sendError(res, e);
  }
});

// ─── Cards ────────────────────────────────────────────────────────────

ownerDealCollageRouter.post("/:id/cards", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const collage = await prisma.dealCollage.findUnique({
      where: { id },
      include: { cards: true },
    });
    if (!collage) throw new NotFoundError("DealCollage", id);
    const parsed = cardSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid card data", parsed.error.errors);
    // Default the new card to the end of the order if none supplied.
    const displayOrder = parsed.data.displayOrder ||
      (collage.cards.reduce((m, c) => Math.max(m, c.displayOrder), 0) + 1);
    const card = await prisma.dealCollageCard.create({
      data: { ...parsed.data, displayOrder, collageId: collage.id },
    });
    memoCache.bust("deal-collages");
    res.status(201).json({ success: true, data: card });
  } catch (e) {
    sendError(res, e);
  }
});

ownerDealCollageRouter.put("/:id/cards/:cardId", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const cardId = req.params.cardId as string;
    const existing = await prisma.dealCollageCard.findFirst({
      where: { id: cardId, collageId: id },
    });
    if (!existing) throw new NotFoundError("DealCollageCard", cardId);
    const parsed = cardSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid card data", parsed.error.errors);
    const card = await prisma.dealCollageCard.update({
      where: { id: cardId },
      data: parsed.data,
    });
    memoCache.bust("deal-collages");
    res.json({ success: true, data: card });
  } catch (e) {
    sendError(res, e);
  }
});

ownerDealCollageRouter.delete("/:id/cards/:cardId", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const cardId = req.params.cardId as string;
    const existing = await prisma.dealCollageCard.findFirst({
      where: { id: cardId, collageId: id },
    });
    if (!existing) throw new NotFoundError("DealCollageCard", cardId);
    await prisma.dealCollageCard.delete({ where: { id: cardId } });
    memoCache.bust("deal-collages");
    res.json({ success: true, message: "Card deleted" });
  } catch (e) {
    sendError(res, e);
  }
});
