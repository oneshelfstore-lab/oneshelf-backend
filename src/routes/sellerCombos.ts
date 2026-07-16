import { Router, type Response } from "express";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole } from "../middleware/firebaseAuth.js";
import { resolveSeller, type SellerRequest } from "../middleware/sellerScope.js";
import { comboSchema, listCombos, createComboRecord, updateComboRecord, deleteComboRecord } from "../services/combos.js";

// Seller router (Firebase auth), mounted at /api/app/seller/combos. Same CRUD as ownerCombos.ts,
// gated to the HOUSE co-manager only (combos bundle house products — a third-party seller has no
// business curating store-wide bundles). Mirrors sellerFreeGifts.ts.
export const sellerComboRouter = Router();
sellerComboRouter.use(firebaseAuthMiddleware as any);
sellerComboRouter.use(requireAppRole("SELLER") as any);
sellerComboRouter.use(resolveSeller as any);

function requireHouse(req: SellerRequest, res: Response): boolean {
  if (req.sellerIsHouse !== true) {
    res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Only the store's house manager can manage combos", details: [] } });
    return false;
  }
  return true;
}

sellerComboRouter.get("/", async (req: SellerRequest, res: Response) => {
  if (!requireHouse(req, res)) return;
  try {
    res.json({ success: true, data: await listCombos() });
  } catch (e) {
    sendError(res, e);
  }
});

sellerComboRouter.post("/", async (req: SellerRequest, res: Response) => {
  if (!requireHouse(req, res)) return;
  try {
    const parsed = comboSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid combo", parsed.error.errors);
    res.status(201).json({ success: true, data: await createComboRecord(parsed.data) });
  } catch (e) {
    sendError(res, e);
  }
});

sellerComboRouter.put("/:id", async (req: SellerRequest, res: Response) => {
  if (!requireHouse(req, res)) return;
  try {
    const parsed = comboSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid combo", parsed.error.errors);
    res.json({ success: true, data: await updateComboRecord(req.params.id as string, parsed.data) });
  } catch (e) {
    sendError(res, e);
  }
});

sellerComboRouter.delete("/:id", async (req: SellerRequest, res: Response) => {
  if (!requireHouse(req, res)) return;
  try {
    await deleteComboRecord(req.params.id as string);
    res.json({ success: true, message: "Combo removed" });
  } catch (e) {
    sendError(res, e);
  }
});
