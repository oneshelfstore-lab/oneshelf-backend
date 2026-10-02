import prisma from "../lib/prisma.js";

// An ACTION notification that nobody dealt with must not pin to the top of the inbox forever (the app
// was uninstalled, the order was handled outside the app, a code path forgot to resolve it). The read
// side simply stops counting ACTION rows older than this, so a missed resolve costs two weeks, not eternity.
export const ACTION_TTL_DAYS = 14;

export function actionCutoff(now = Date.now()): Date {
  return new Date(now - ACTION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Mark ACTION notifications as dealt with. Call it from the code path that CLOSES the loop (order
 * packed, routine approved, complaint answered…), not from the screen.
 *
 * Never throws: resolving is bookkeeping, and it must not turn a successful business action into a 500.
 * `types` is required so a call can only ever clear the specific notifications it means to.
 */
export async function resolveActions(w: {
  types: string[];
  entityType?: string;
  entityId?: string;
  /** Limit to one person's rows (e.g. only THIS seller's "new order", not every seller's). */
  userId?: string;
}): Promise<void> {
  try {
    // ⚠️ Needs a scope. With neither an entity nor a user this would clear every matching row for
    // everyone — exactly what an `undefined` id slipping through a caller would do.
    if (w.types.length === 0 || (!(w.entityType && w.entityId) && !w.userId)) return;
    await prisma.notification.updateMany({
      where: {
        kind: "ACTION",
        resolvedAt: null,
        type: { in: w.types },
        ...(w.entityType && w.entityId ? { entityType: w.entityType, entityId: w.entityId } : {}),
        ...(w.userId ? { userId: w.userId } : {}),
      },
      data: { resolvedAt: new Date() },
    });
  } catch (e) {
    console.error("resolveActions failed:", e);
  }
}
