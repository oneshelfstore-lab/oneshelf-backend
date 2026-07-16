import { Router, type Request, type Response } from "express";
import { sendError, NotFoundError } from "../lib/errors.js";
import { cacheControl } from "../lib/httpCache.js";
import { getPublicCombos } from "../services/combos.js";

// Public router (no auth), mounted at /api/app/combos. Customer-facing curated bundles.
export const publicComboRouter = Router();

publicComboRouter.get("/", cacheControl(60), async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getPublicCombos() });
  } catch (e) {
    sendError(res, e);
  }
});

publicComboRouter.get("/:id", cacheControl(60), async (req: Request, res: Response) => {
  try {
    const combo = (await getPublicCombos()).find((c) => c.id === (req.params.id as string));
    if (!combo) throw new NotFoundError("Combo", req.params.id as string);
    res.json({ success: true, data: combo });
  } catch (e) {
    sendError(res, e);
  }
});
