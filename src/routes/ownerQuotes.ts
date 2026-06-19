import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError, NotFoundError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { shapeQuote } from "./appUser.js";

// Owner quote-request inbox. Mounted at /api/app/owner/quote-requests.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// GET /api/app/owner/quote-requests → all requests + customer name/phone (newest first)
router.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    const quotes = await prisma.quoteRequest.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: { select: { name: true, phone: true } } },
    });
    res.json({ success: true, data: quotes.map((q) => shapeQuote(q)) });
  } catch (e) {
    sendError(res, e);
  }
});

const quoteSchema = z.object({
  amount: z.number().positive(),
  message: z.string().max(2000).default(""),
});

// POST /api/app/owner/quote-requests/:id/quote → send a price (status → QUOTED)
router.post("/:id/quote", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid quotation", parsed.error.errors);

    const existing = await prisma.quoteRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Quote request", id);

    const updated = await prisma.quoteRequest.update({
      where: { id },
      data: {
        quotedAmount: parsed.data.amount,
        quoteMessage: parsed.data.message.trim(),
        status: "QUOTED",
      },
      include: { user: { select: { name: true, phone: true } } },
    });
    res.json({ success: true, data: shapeQuote(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

// POST /api/app/owner/quote-requests/:id/fulfill → mark fulfilled
router.post("/:id/fulfill", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const id = String(req.params.id ?? "");
    const existing = await prisma.quoteRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Quote request", id);

    const updated = await prisma.quoteRequest.update({
      where: { id },
      data: { status: "FULFILLED" },
      include: { user: { select: { name: true, phone: true } } },
    });
    res.json({ success: true, data: shapeQuote(updated) });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
