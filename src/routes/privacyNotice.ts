import { Router, type Request, type Response } from "express";
import { NOTICE } from "../data/customerPrivacyNotice.js";

// Public read of the customer DPDP notice (Rules 2025, Rule 3). Mounted at /api/app/privacy-notice
// BEFORE the auth guards and deliberately unauthenticated: the notice has to be readable before
// someone signs up, because the whole point is that it is shown at or before collection.
const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({ success: true, data: NOTICE });
});

export default router;
