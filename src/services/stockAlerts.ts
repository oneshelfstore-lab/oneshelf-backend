import prisma from "../lib/prisma.js";
import { notifyBackInStock } from "./fcmNotifier.js";

/**
 * A variant just crossed from out-of-stock into having stock again. Pings every customer who
 * tapped "Notify me" while it was out, then marks them notified so the next restock of the
 * same variant doesn't re-ping someone who already got word (they'd resubscribe if they want
 * another alert next time it runs out).
 */
export async function notifyStockAlerts(variantId: string): Promise<void> {
  const alerts = await prisma.stockAlert.findMany({
    where: { variantId, notified: false },
    select: { id: true, userId: true },
  });
  if (alerts.length === 0) return;

  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { product: { select: { name: true } } },
  });
  const productName = variant?.product.name ?? "An item on your list";

  await prisma.stockAlert.updateMany({
    where: { id: { in: alerts.map((a) => a.id) } },
    data: { notified: true },
  });

  await Promise.all(alerts.map((a) => notifyBackInStock(a.userId, productName)));
}
