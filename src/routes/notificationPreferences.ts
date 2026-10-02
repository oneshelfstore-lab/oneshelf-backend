import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma.js";
import { sendError, ValidationError } from "../lib/errors.js";
import { firebaseAuthMiddleware, type FirebaseAuthRequest } from "../middleware/firebaseAuth.js";
import { PREFERENCE_TOPICS } from "../services/notificationCatalog.js";

// The optional notification topics a person can switch off. Mounted at /api/app/me/notification-preferences
// (before /api/app/me). Mandatory notifications are not listed and cannot be changed here.
const router = Router();
router.use(firebaseAuthMiddleware as any);

async function currentList(userId: string) {
  const off = new Set(
    (await prisma.notificationPreference.findMany({ where: { userId, push: false }, select: { topic: true } })).map((p) => p.topic),
  );
  return PREFERENCE_TOPICS.map((t) => ({ key: t.key, label: t.label, description: t.description, push: !off.has(t.key) }));
}

router.get("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: { topics: await currentList(req.appUser!.id) } });
  } catch (e) {
    sendError(res, e);
  }
});

const putSchema = z.object({ topic: z.string().min(1).max(40), push: z.boolean() });

router.put("/", async (req: FirebaseAuthRequest, res: Response) => {
  try {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid preference", parsed.error.errors);
    const { topic, push } = parsed.data;
    // ⚠️ Whitelist, not "any string": this is what guarantees an order/payment alert can never be muted.
    if (!PREFERENCE_TOPICS.some((t) => t.key === topic)) throw new ValidationError("That notification can't be switched off.");

    const userId = req.appUser!.id;
    if (push) {
      // On is the default, so turning it back on just removes the override.
      await prisma.notificationPreference.deleteMany({ where: { userId, topic } });
    } else {
      await prisma.notificationPreference.upsert({
        where: { userId_topic: { userId, topic } },
        update: { push: false },
        create: { userId, topic, push: false },
      });
    }
    res.json({ success: true, data: { topics: await currentList(userId) } });
  } catch (e) {
    sendError(res, e);
  }
});

export default router;
