import { Router, type Response } from "express";
import { z } from "zod";
import { sendError, ValidationError } from "../lib/errors.js";
import {
  firebaseAuthMiddleware,
  requireAppRole,
  type FirebaseAuthRequest,
} from "../middleware/firebaseAuth.js";
import { notifyBroadcast } from "../services/fcmNotifier.js";

// Owner broadcast composer (send-now). Mounted at /api/app/owner/broadcast.
// Scheduled sends stay on the legacy Firebase Cloud Function by design.
const router = Router();
router.use(firebaseAuthMiddleware as any);
router.use(requireAppRole("OWNER") as any);

// target is a STABLE enum key (not a display label) → a real FCM topic the app
// subscribes to. ALL = every logged-in customer; OFFERS = opted-in customers.
const TOPIC_BY_TARGET: Record<string, string> = {
  ALL: "all_users",
  OFFERS: "offers",
};

const broadcastSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
  target: z.enum(["ALL", "OFFERS"]).default("ALL"),
});

router.post("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = broadcastSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid broadcast", parsed.error.errors);

    const topic = TOPIC_BY_TARGET[parsed.data.target] ?? "all_users";
    await notifyBroadcast(topic, parsed.data.title.trim(), parsed.data.body.trim());

    res.json({ success: true, message: "Broadcast sent" });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
