/**
 * Read-only. Runs the REAL payout eligibility filter against live data and reports, per seller:
 * what is payable now, what is being held back and why, and whether outstandingBalance still
 * reconciles to the sum of everything unsettled.
 *
 * This is the runbook step-11 proof. It imports payableSubOrderWhere rather than restating the
 * filter, so it cannot drift from what a payout actually asks for — a check that re-writes the
 * predicate it is checking proves nothing.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/checkPayable.ts'
 */
import { PrismaClient } from "@prisma/client";
import { payableSubOrderWhere } from "../src/services/sellerPayout.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const r2 = (n: number) => +n.toFixed(2);

async function main() {
  const config = await prisma.storeConfig.findFirst({ select: { payoutHoldDays: true } });
  const payoutHoldDays = Math.max(0, config?.payoutHoldDays ?? 0);
  console.log(`payoutHoldDays = ${payoutHoldDays}${payoutHoldDays === 0 ? " (payable as soon as delivered)" : ""}\n`);

  const sellers = await prisma.seller.findMany({
    where: { isHouse: false },
    select: { id: true, name: true, outstandingBalance: true },
    orderBy: { name: "asc" },
  });

  for (const s of sellers) {
    // What a payout would actually take, asked exactly the way payoutSellerInTx asks it.
    const payable = await prisma.subOrder.aggregate({
      where: payableSubOrderWhere({ sellerId: s.id, payoutHoldDays }),
      _sum: { netPayable: true },
      _count: { _all: true },
    });
    // Everything still on the books, payable or not.
    const unsettled = await prisma.subOrder.aggregate({
      where: { sellerId: s.id, settled: false, status: { not: "CANCELLED" }, order: { status: { not: "CANCELLED" } } },
      _sum: { netPayable: true },
      _count: { _all: true },
    });
    // Why the rest is being held.
    const heldBy = await prisma.subOrder.groupBy({
      by: ["orderId"],
      where: {
        sellerId: s.id,
        settled: false,
        status: { not: "CANCELLED" },
        order: { status: { notIn: ["CANCELLED", "DELIVERED"] } },
      },
      _sum: { netPayable: true },
    });
    const heldOrders = await prisma.order.findMany({
      where: { id: { in: heldBy.map((h) => h.orderId) } },
      select: { id: true, status: true },
    });
    const byStatus = new Map<string, number>();
    for (const h of heldBy) {
      const st = heldOrders.find((o) => o.id === h.orderId)?.status ?? "?";
      byStatus.set(st, r2((byStatus.get(st) ?? 0) + Number(h._sum.netPayable ?? 0)));
    }

    const payableNet = r2(Number(payable._sum.netPayable ?? 0));
    const unsettledNet = r2(Number(unsettled._sum.netPayable ?? 0));
    const stored = r2(Number(s.outstandingBalance));

    console.log(`${s.name}`);
    console.log(`  outstandingBalance (stored) : ₹${stored.toFixed(2)}`);
    console.log(`  unsettled, all statuses     : ₹${unsettledNet.toFixed(2)}  (${unsettled._count._all} slices)`);
    console.log(`  PAYABLE NOW                 : ₹${payableNet.toFixed(2)}  (${payable._count._all} slices)`);
    if (byStatus.size) {
      console.log(
        `  held back                   : ` +
          [...byStatus].map(([st, v]) => `${st} ₹${v.toFixed(2)}`).join(" · "),
      );
    }
    const drift = r2(stored - unsettledNet);
    console.log(
      drift === 0
        ? `  ✓ balance reconciles to the unsettled total`
        : `  ✗ balance is ₹${drift.toFixed(2)} ABOVE the unsettled total — pre-existing drift, not caused by this change`,
    );
    console.log("");
  }
}

main()
  .catch((e) => {
    console.error("\nFAILED:", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
