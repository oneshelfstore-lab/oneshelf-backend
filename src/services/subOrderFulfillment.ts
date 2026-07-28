import prisma from "../lib/prisma.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";

// A parent order at PACKED must imply "every seller's slice is physically ready", because the delivery
// agent's collection run refuses to collect a stop whose SubOrder isn't PACKED
// (routes/delivery.ts POST /:id/collect/:subOrderId → "Seller hasn't packed these items yet").
//
// The seller-driven path already holds that invariant (maybeAdvanceParentOrder in routes/sellerOrders.ts
// only advances once every slice is PACKED/COLLECTED/CANCELLED). The owner/admin status routes did NOT,
// so forcing an order to PACKED while a seller was still preparing DEADLOCKED it: the agent couldn't
// collect that stop, the order could never auto-advance to OUT_FOR_DELIVERY, and the owner is not exempt
// from the collect-time check either — nobody could move it.

// A slice is "ready" once the seller is done with it one way or another; CANCELLED counts because a
// rejected slice is skipped by the collection run rather than collected.
const READY_STATUSES = ["PACKED", "COLLECTED", "CANCELLED"];

export type SliceReadiness = { status: string; sellerName: string; isHouse: boolean };

/**
 * The names of the sellers still blocking collection, in order.
 *
 * ⚠️ House slices are deliberately exempt: they sit at the dispatch point and the collect route
 * auto-collects them regardless of status, so they can never block the run. Without this exemption the
 * guard would block every ordinary single-store order whose house slice nobody bothered to tick.
 */
export function unpackedSellers(slices: SliceReadiness[]): string[] {
  return slices
    .filter((s) => !s.isHouse && !READY_STATUSES.includes(s.status))
    .map((s) => s.sellerName);
}

export function packBlockerMessage(names: string[]): string {
  return (
    `${names.join(", ")} ${names.length === 1 ? "hasn't" : "haven't"} packed their items yet, so the ` +
    "delivery partner can't collect from them. Wait for them, or mark their part packed on their behalf."
  );
}

export async function assertSellersPacked(orderId: string): Promise<void> {
  const rows = await prisma.subOrder.findMany({
    where: { orderId },
    select: { status: true, seller: { select: { name: true, isHouse: true } } },
  });
  const blocking = unpackedSellers(
    rows.map((r) => ({ status: r.status, sellerName: r.seller.name, isHouse: r.seller.isHouse })),
  );
  if (blocking.length > 0) throw new ValidationError(packBlockerMessage(blocking));
}

/**
 * The escape hatch the guard needs: a seller who has physically bagged the goods but never tapped
 * "packed" in their app would otherwise strand the order at CONFIRMED forever. Same write the seller's
 * own PATCH /status does, attributed to the owner. Also the recovery path for orders already stuck at
 * PACKED from before the guard existed.
 *
 * Deliberately does NOT auto-advance the parent order (maybeAdvanceParentOrder lives in the seller route
 * and is not shared): the owner is on the dispatch board and advances it with the button that's already
 * there — which now passes assertSellersPacked.
 */
export async function markSubOrderPackedByOwner(
  orderId: string,
  subOrderId: string,
): Promise<{ subOrderId: string; sellerName: string; status: string }> {
  const sub = await prisma.subOrder.findFirst({
    where: { id: subOrderId, orderId },
    select: { id: true, status: true, seller: { select: { name: true } } },
  });
  if (!sub) throw new NotFoundError("SubOrder", subOrderId);

  if (sub.status === "CANCELLED") {
    throw new ValidationError(`${sub.seller.name} rejected this order — their items can't be packed.`);
  }
  // Idempotent: already PACKED (or COLLECTED) is a no-op success.
  if (sub.status === "PLACED" || sub.status === "ACCEPTED") {
    await prisma.subOrder.update({
      where: { id: sub.id },
      data: { status: "PACKED", packedAt: new Date() },
    });
  }

  return { subOrderId: sub.id, sellerName: sub.seller.name, status: "PACKED" };
}
