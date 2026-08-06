import prisma from "../lib/prisma.js";
import { notifyNewDeliveryAvailable, notifyUnclaimedOrder, notifyDocumentExpiry } from "./fcmNotifier.js";

/**
 * Nobody picked it up. The pool model is right at this store's scale (2–5 riders — a real
 * offer-and-cascade engine with per-rider countdowns would be enormous overkill), but a pool has one
 * failure mode: an order can sit in it with everyone assuming someone else took it, and the only
 * thing that ever surfaced that was a customer ringing to ask where their groceries were.
 *
 * So: re-ping the riders once, and tell the owner — who is the actual fallback, since they can
 * assign it by hand or deliver it themselves.
 *
 * ponytail: one flat timeout, no cascade, no per-rider offers. Revisit if the store ever runs enough
 * riders that "who was offered this" becomes a real question.
 */
const UNCLAIMED_AFTER_MS = 10 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;

export async function escalateUnclaimedOrders(): Promise<number> {
  const cutoff = new Date(Date.now() - UNCLAIMED_AFTER_MS);

  const stale = await prisma.order.findMany({
    where: {
      status: "PACKED",
      fulfillmentType: "DELIVERY",
      deliveryBoyId: null,
      // Packed long enough ago to be a real problem, not a rider who's simply mid-tap.
      updatedAt: { lt: cutoff },
      // The latch — tell the owner once per unclaimed spell, not every 5 minutes forever.
      deliveryEscalatedAt: null,
      // An unpaid online order isn't waiting on a rider, it's waiting on the customer. Mirrors
      // PAYMENT_SETTLED in ownerOrders.ts — those orders are off the board entirely.
      NOT: { paymentMethod: { in: ["ONLINE", "UPI"] }, paymentStatus: "PENDING" },
    },
    select: { id: true, orderNumber: true, updatedAt: true, deliveryBoyId: true, fulfillmentType: true },
  });
  if (stale.length === 0) return 0;

  for (const order of stale) {
    try {
      // Stamp FIRST. If the notify below throws, we've still recorded that we tried — better one
      // missed ping than the owner's phone buzzing about the same order every five minutes.
      await prisma.order.update({
        where: { id: order.id },
        data: { deliveryEscalatedAt: new Date() },
      });
      const waitingMin = Math.round((Date.now() - order.updatedAt.getTime()) / 60000);
      await notifyUnclaimedOrder(order, waitingMin);
      // One more nudge at the riders too — the first push may have landed while everyone was busy.
      await notifyNewDeliveryAvailable(order);
    } catch (e) {
      console.error("delivery escalation failed for order", order.id, e);
    }
  }
  return stale.length;
}

/**
 * Warn riders whose licence or insurance is about to lapse, and tell the owner once it has.
 *
 * Both dates were already being collected — insuranceExpiry since Phase 1, dlExpiry as of Phase 2 —
 * and read by absolutely nothing. Someone riding for the store on an expired licence is a live legal
 * exposure, and the first anyone would have known about it is an accident.
 *
 * Warns at 30 and 7 days, then once on expiry. Returns how many riders were told.
 */
const WARN_DAYS = [30, 7];

export async function checkRiderDocumentExpiry(): Promise<number> {
  const profiles = await prisma.deliveryProfile.findMany({
    where: {
      onboardingStatus: "APPROVED",
      vehicleType: { not: "CYCLE" }, // a cycle has neither licence nor insurance
      OR: [{ dlExpiry: { not: null } }, { insuranceExpiry: { not: null } }],
    },
    select: {
      userId: true,
      dlExpiry: true,
      insuranceExpiry: true,
      user: { select: { name: true, role: true } },
    },
  });

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let told = 0;

  for (const p of profiles) {
    if (p.user.role !== "DELIVERY") continue; // demoted since approval — not their problem any more
    const docs: Array<[string, Date | null]> = [
      ["driving licence", p.dlExpiry],
      ["vehicle insurance", p.insuranceExpiry],
    ];
    for (const [label, expiry] of docs) {
      if (!expiry) continue;
      const daysLeft = Math.floor((expiry.getTime() - now) / dayMs);
      // Exact-day matches only, so a rider gets each warning ONCE rather than daily for a month.
      // A sweep that misses a day (deploy, restart) simply skips that warning — deliberately no
      // "have we warned yet" column for something this low-stakes.
      const isWarnDay = WARN_DAYS.includes(daysLeft);
      const justExpired = daysLeft === 0 || daysLeft === -1;
      if (!isWarnDay && !justExpired) continue;

      try {
        await notifyDocumentExpiry(p.userId, {
          riderName: p.user.name,
          document: label,
          daysLeft,
        });
        told++;
      } catch (e) {
        console.error("document expiry notify failed for", p.userId, e);
      }
    }
  }
  return told;
}

/** Backup driver for the escalation sweep (the document check rides the daily internal cron). */
export function startDeliveryEscalationSweeper(): void {
  const timer = setInterval(() => {
    escalateUnclaimedOrders().catch((e) => console.error("delivery escalation sweep failed:", e));
  }, SWEEP_EVERY_MS);
  timer.unref?.();
}
