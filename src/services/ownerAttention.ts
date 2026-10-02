import prisma from "../lib/prisma.js";

// "What needs the owner right now", counted live from the tables that hold the work — NOT from
// notification rows. A notification can be cleared, missed or never delivered; "3 sellers waiting"
// has to stay true regardless. See NOTIFICATIONS_PLAN.md Phase 6.

/** Same threshold as services/deliveryEscalation.ts: packed this long with no rider is a real problem. */
const UNCLAIMED_AFTER_MS = 10 * 60 * 1000;

export type OwnerAttention = {
  total: number;
  sellers: { applications: number; sellerReview: number; riderReview: number };
  payments: { cashHandovers: number; cashAmount: number };
  delivery: { unclaimed: number; failed: number; courierFailed: number };
  support: { complaints: number; quotes: number };
};

export async function getOwnerAttention(now = Date.now()): Promise<OwnerAttention> {
  const unclaimedCutoff = new Date(now - UNCLAIMED_AFTER_MS);

  const [applications, sellerReview, riderReview, handovers, unclaimed, failed, courierFailed, complaints, quotes] =
    await Promise.all([
      // "Partner with us" leads nobody has answered yet.
      prisma.partnerApplication.count({ where: { status: "PENDING" } }),
      // KYC submitted and waiting on a human. The house store never goes through onboarding.
      prisma.seller.count({ where: { isHouse: false, onboardingStatus: "PENDING_REVIEW" } }),
      // Only current riders — an ex-rider keeps a DeliveryProfile (see ownerOnboardingQueue.ts).
      prisma.deliveryProfile.count({ where: { onboardingStatus: "PENDING_REVIEW", user: { role: "DELIVERY" } } }),
      // A rider says they handed over cash; the debt stays until the owner confirms.
      prisma.cashSettlement.aggregate({ where: { status: "PENDING" }, _count: { _all: true }, _sum: { amount: true } }),
      // Packed, nobody has it. Mirrors escalateUnclaimedOrders, including leaving out unpaid online
      // orders (those wait on the customer, not on a rider) and orders that already failed once
      // (counted under `failed` instead, so one order is never counted twice).
      prisma.order.count({
        where: {
          status: "PACKED",
          fulfillmentType: "DELIVERY",
          deliveryBoyId: null,
          lastDeliveryFailedAt: null,
          updatedAt: { lt: unclaimedCutoff },
          NOT: { paymentMethod: { in: ["ONLINE", "UPI"] }, paymentStatus: "PENDING" },
        },
      }),
      // A delivery attempt failed and the order went back to PACKED; it leaves this count the moment a
      // rider picks it up again (OUT_FOR_DELIVERY) or the owner cancels it.
      prisma.order.count({ where: { status: "PACKED", lastDeliveryFailedAt: { not: null } } }),
      prisma.courierBooking.count({ where: { status: "FAILED" } }),
      prisma.complaint.count({ where: { status: "OPEN" } }),
      // Bulk-quote requests the owner hasn't priced yet.
      prisma.quoteRequest.count({ where: { status: "PENDING" } }),
    ]);

  const out: OwnerAttention = {
    total: 0,
    sellers: { applications, sellerReview, riderReview },
    payments: { cashHandovers: handovers._count._all, cashAmount: Number(handovers._sum.amount ?? 0) },
    delivery: { unclaimed, failed, courierFailed },
    support: { complaints, quotes },
  };
  out.total =
    applications + sellerReview + riderReview + out.payments.cashHandovers +
    unclaimed + failed + courierFailed + complaints + quotes;
  return out;
}
