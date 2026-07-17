import prisma from "../lib/prisma.js";

/** Same output shape QuoteThread.kt already renders (id/sender/text/voiceUrl/imageUrls/createdAt). */
export function shapeOrderMessage(m: { id: string; sender: string; text: string | null; voiceUrl: string | null; imageUrls: string[]; createdAt: Date }) {
  return { id: m.id, sender: m.sender, text: m.text, voiceUrl: m.voiceUrl, imageUrls: m.imageUrls, createdAt: m.createdAt.getTime() };
}

/** Distinct sellerIds with a slice of this order — seller-route ownership checks + notify fanout. */
export async function sellerIdsForOrder(orderId: string): Promise<string[]> {
  const rows = await prisma.subOrder.findMany({ where: { orderId }, select: { sellerId: true }, distinct: ["sellerId"] });
  return rows.map((r) => r.sellerId);
}

/** The owner-login userIds behind a set of sellerIds — for FCM token lookup (Seller isn't a User). */
export async function ownerUserIdsForSellers(sellerIds: string[]): Promise<string[]> {
  if (sellerIds.length === 0) return [];
  const sellers = await prisma.seller.findMany({ where: { id: { in: sellerIds } }, select: { ownerUserId: true } });
  return sellers.map((s) => s.ownerUserId).filter((v): v is string => Boolean(v));
}
