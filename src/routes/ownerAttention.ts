import { Router, type Response } from "express";
import { sendError } from "../lib/errors.js";
import { firebaseAuthMiddleware, requireAppRole, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { getOwnerAttention } from "../services/ownerAttention.js";

// Owner "needs attention" counters for the notification centre. Mounted at /api/app/owner/attention.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

router.get("/", async (_req: FirebaseAuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: await getOwnerAttention() });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
