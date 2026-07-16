import { Router, type Response } from "express";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { comboSchema, listCombos, createComboRecord, updateComboRecord, deleteComboRecord } from "../services/combos.js";

// Owner router (Firebase auth), mounted at /api/app/owner/combos. Curated bundle CRUD.
// House-only (validated in the service). Mirrors ownerFreeGifts.ts; the house co-manager gets the
// same CRUD via sellerCombos.ts — both call the same service, so the two surfaces can't drift.
export const ownerComboRouter = Router();
ownerComboRouter.use(firebaseAuthMiddleware as any);
ownerComboRouter.use(requireAppRole("OWNER") as any);

ownerComboRouter.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: await listCombos() });
  } catch (e) {
    sendError(res, e);
  }
});

ownerComboRouter.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = comboSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid combo", parsed.error.errors);
    res.status(201).json({ success: true, data: await createComboRecord(parsed.data) });
  } catch (e) {
    sendError(res, e);
  }
});

ownerComboRouter.put("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = comboSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid combo", parsed.error.errors);
    res.json({ success: true, data: await updateComboRecord(req.params.id as string, parsed.data) });
  } catch (e) {
    sendError(res, e);
  }
});

ownerComboRouter.delete("/:id", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    await deleteComboRecord(req.params.id as string);
    res.json({ success: true, message: "Combo removed" });
  } catch (e) {
    sendError(res, e);
  }
});
