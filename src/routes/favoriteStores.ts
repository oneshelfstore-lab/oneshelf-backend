import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";

// A customer's saved shops (the heart on the store page). Mounted at /api/app/me/favorite-stores,
// BEFORE the general /api/app/me router. Ids only: the app already has the store list.
const router = Router();
router.use(firebaseAuthMiddleware as any);

router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const rows = await prisma.favoriteStore.findMany({
      where: { userId: req.appUser!.id },
      orderBy: { createdAt: "desc" },
      select: { sellerId: true },
    });
    res.json({ success: true, data: rows.map((r) => r.sellerId) });
  } catch (err) {
    sendError(res, err);
  }
});

// Idempotent add.
router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const sellerId = typeof req.body?.sellerId === "string" ? req.body.sellerId : "";
    if (!sellerId) throw new ValidationError("sellerId is required");
    const seller = await prisma.seller.findUnique({ where: { id: sellerId }, select: { id: true } });
    if (!seller) throw new ValidationError("Unknown store");
    await prisma.favoriteStore.upsert({
      where: { userId_sellerId: { userId: req.appUser!.id, sellerId } },
      create: { userId: req.appUser!.id, sellerId },
      update: {},
    });
    res.status(201).json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Idempotent remove.
router.delete("/:sellerId", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    await prisma.favoriteStore.deleteMany({
      where: { userId: req.appUser!.id, sellerId: String(req.params.sellerId ?? "") },
    });
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
