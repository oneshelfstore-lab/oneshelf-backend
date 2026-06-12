import prisma from "../lib/prisma.js";

export interface UserSavings {
  yearToDate: number;
  allTime: number;
}

/**
 * Cumulative savings for a user, computed by AGGREGATE (not a denormalized counter on User).
 * A SUM is always correct: it naturally excludes cancelled orders and needs no year-boundary
 * reset or decrement-on-cancel bookkeeping. Pre-migration orders have savedAmount = 0, so the
 * counter starts truthful from the day this ships.
 */
export async function computeUserSavings(userId: string): Promise<UserSavings> {
  const startOfYear = new Date(new Date().getFullYear(), 0, 1);

  const [yearAgg, allAgg] = await Promise.all([
    prisma.order.aggregate({
      _sum: { savedAmount: true },
      where: { customerId: userId, status: { not: "CANCELLED" }, createdAt: { gte: startOfYear } },
    }),
    prisma.order.aggregate({
      _sum: { savedAmount: true },
      where: { customerId: userId, status: { not: "CANCELLED" } },
    }),
  ]);

  return {
    yearToDate: Number(yearAgg._sum.savedAmount ?? 0),
    allTime: Number(allAgg._sum.savedAmount ?? 0),
  };
}
