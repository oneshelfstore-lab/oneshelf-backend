import prisma from "../lib/prisma.js";
import { notifyAbandonedCart } from "./fcmNotifier.js";

const IDLE_HOURS = 4;
const REMINDER_COOLDOWN_HOURS = 24;
const MIN_CART_VALUE = 100; // ₹

export async function sweepAbandonedCarts(): Promise<number> {
  const idleCutoff = new Date(Date.now() - IDLE_HOURS * 60 * 60 * 1000);
  const cooldownCutoff = new Date(Date.now() - REMINDER_COOLDOWN_HOURS * 60 * 60 * 1000);

  // Users with idle active carts who haven't been reminded recently and have FCM tokens.
  const candidates = await prisma.user.findMany({
    where: {
      isActive: true,
      AND: [
        { cartItems: { some: { savedForLater: false, updatedAt: { lt: idleCutoff } } } },
        { fcmTokens: { some: {} } },
        {
          OR: [
            { lastCartReminderAt: null },
            { lastCartReminderAt: { lt: cooldownCutoff } },
          ],
        },
      ],
    },
    select: {
      id: true,
      name: true,
      cartItems: {
        where: { savedForLater: false },
        include: {
          variant: {
            select: {
              sellingPrice: true,
              stock: true,
              product: { select: { name: true, imageUrls: true } },
            },
          },
        },
      },
    },
  });

  let sent = 0;

  for (const user of candidates) {
    try {
      const inStockItems = user.cartItems.filter(
        (ci) => Number(ci.variant.stock) > 0,
      );
      if (inStockItems.length === 0) continue;

      const cartValue = inStockItems.reduce(
        (sum, ci) => sum + ci.quantity * Number(ci.variant.sellingPrice),
        0,
      );
      if (cartValue < MIN_CART_VALUE) continue;

      // Skip if user placed an order after their most recent cart update.
      const mostRecentCartUpdate = new Date(
        Math.max(...user.cartItems.map((ci) => ci.updatedAt.getTime())),
      );
      const recentOrder = await prisma.order.findFirst({
        where: { customerId: user.id, createdAt: { gt: mostRecentCartUpdate } },
        select: { id: true },
      });
      if (recentOrder) continue;

      const topItemName = inStockItems[0]?.variant.product.name ?? "your items";

      await notifyAbandonedCart(user.id, {
        itemCount: inStockItems.length,
        cartValue: Math.round(cartValue),
        topItemName,
      });

      await prisma.user.update({
        where: { id: user.id },
        data: {
          lastCartReminderAt: new Date(),
          cartReminderCount: { increment: 1 },
        },
      });

      sent++;
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "abandoned-cart notify failed",
          userId: user.id,
          err: String(err),
        }),
      );
    }
  }

  if (sent > 0) {
    console.log(
      JSON.stringify({ level: "info", msg: "abandoned-cart reminders sent", count: sent }),
    );
  }
  return sent;
}

export function startAbandonedCartSweeper(intervalMs = 15 * 60 * 1000): void {
  const timer = setInterval(() => {
    sweepAbandonedCarts().catch((e) =>
      console.error(
        JSON.stringify({ level: "error", msg: "abandoned-cart sweep crashed", err: String(e) }),
      ),
    );
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
