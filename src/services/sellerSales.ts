import type { Prisma } from "@prisma/client";

// A sale = a slice that isn't cancelled and whose payment isn't still pending online. Mirrors
// sellerOrders.ts PAYMENT_SETTLED: an ONLINE/UPI order the customer never paid for is not money the
// seller will ever see, and the seller's own orders list already hides it — counting it in the
// analytics made the sales figures disagree with the orders the seller can actually see.
export const SELLER_SALE: Prisma.SubOrderWhereInput = {
  status: { not: "CANCELLED" },
  order: { is: { NOT: { paymentMethod: { in: ["ONLINE", "UPI"] }, paymentStatus: "PENDING" } } },
};
