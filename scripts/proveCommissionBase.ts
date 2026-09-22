/**
 * Runbook step 07's prove, against live data. Performs NO writes.
 *
 * Its words: "Reproduce the two-seller worked example by hand: seller A nets ₹223.00, seller B nets
 * ₹93.50, platform retains ₹19.50 from the sellers." That is pinned as a test
 * (services/__tests__/sellerSplit.test.ts); this is the other question a money change owes an
 * answer to — WHAT IT DOES TO THE BOOK THAT ALREADY EXISTS.
 *
 * Every live slice is re-derived under the new rule and compared against what is stored. Nothing is
 * written: historical rows were correct under the rule in force when they were placed, nothing has
 * been filed and nothing has been paid out, and re-basing them would retroactively restate what a
 * seller is owed for a contract term that was only just settled. This prints the size of that
 * decision rather than taking it.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/proveCommissionBase.ts'
 */
import { PrismaClient } from "@prisma/client";
import { sumSellerLines } from "../src/services/sellerSplit.js";
import { COMMISSION_GST_RATE_PCT } from "../src/data/commissionTax.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => +v.toFixed(2);

async function main() {
  console.log(`Commission base: taxableValue (GST-exclusive). GST on commission: ${COMMISSION_GST_RATE_PCT}%, withheld.\n`);

  const slices = await prisma.subOrder.findMany({
    where: { status: { not: "CANCELLED" }, order: { is: { status: { not: "CANCELLED" } } } },
    select: {
      commissionPct: true, commissionAmount: true, commissionGstAmount: true, subtotal: true,
      settled: true,
      seller: { select: { name: true, isHouse: true } },
      items: {
        select: {
          lineTotal: true, taxableValue: true,
          variant: { select: { product: { select: { commissionPctOverride: true } } } },
        },
      },
    },
  });

  type Agg = { slices: number; gross: number; taxable: number; oldC: number; newC: number; gst: number };
  const bySeller = new Map<string, Agg>();
  let grossNeTaxable = 0;

  for (const s of slices) {
    if (s.items.length === 0) continue;
    const lines = s.items.map((i) => ({
      lineTotal: n(i.lineTotal),
      taxableValue: n(i.taxableValue),
      commissionPctOverride:
        i.variant?.product.commissionPctOverride == null ? null : Number(i.variant.product.commissionPctOverride),
    }));
    const t = sumSellerLines(lines, n(s.commissionPct));
    if (t.subtotal !== t.taxableValue) grossNeTaxable++;

    const key = s.seller.name + (s.seller.isHouse ? " [house]" : "");
    const a = bySeller.get(key) ?? { slices: 0, gross: 0, taxable: 0, oldC: 0, newC: 0, gst: 0 };
    a.slices += 1;
    a.gross = r2(a.gross + t.subtotal);
    a.taxable = r2(a.taxable + t.taxableValue);
    a.oldC = r2(a.oldC + n(s.commissionAmount)); // what is stored, on the old base
    a.newC = r2(a.newC + t.commissionAmount); // what the same lines produce now
    a.gst = r2(a.gst + t.commissionGstAmount);
    bySeller.set(key, a);
  }

  console.log("seller                    slices      gross    taxable   commission: stored -> new   GST now withheld");
  let totalOld = 0, totalNew = 0, totalGst = 0;
  for (const [name, a] of [...bySeller].sort((x, y) => x[0].localeCompare(y[0]))) {
    totalOld = r2(totalOld + a.oldC); totalNew = r2(totalNew + a.newC); totalGst = r2(totalGst + a.gst);
    console.log(
      `  ${name.padEnd(24)} ${String(a.slices).padStart(5)} ${a.gross.toFixed(2).padStart(10)}` +
      ` ${a.taxable.toFixed(2).padStart(10)}   ${a.oldC.toFixed(2).padStart(8)} -> ${a.newC.toFixed(2).padStart(8)}` +
      `   ${a.gst.toFixed(2).padStart(8)}`,
    );
  }
  console.log(
    `\n  commission across the whole live book: ${totalOld.toFixed(2)} -> ${totalNew.toFixed(2)}` +
    `  (${r2(totalNew - totalOld) >= 0 ? "+" : ""}${r2(totalNew - totalOld).toFixed(2)})` +
    `\n  GST on it, previously a receivable, now withheld: ${totalGst.toFixed(2)}` +
    `\n  live slices where gross differs from taxable: ${grossNeTaxable} of ${slices.length}`,
  );

  console.log(
    `\n⚠️ NOTHING ABOVE IS WRITTEN. Those rows were correct under the rule in force when they were` +
    `\n   placed. The figures show what re-basing them WOULD move, so that staying put is a decision` +
    `\n   somebody made rather than one nobody noticed. Nothing is filed and nothing is paid out, so` +
    `\n   the choice is genuinely still open.`,
  );

  // The worked example, reproduced from the same function placement uses.
  const A = sumSellerLines([{ lineTotal: 236, taxableValue: 200 }], 5);
  const B = sumSellerLines([{ lineTotal: 100, taxableValue: 100 }], 5);
  const netA = r2(236 - A.commissionAmount - A.commissionGstAmount - 1.0 - 0.2);
  const netB = r2(100 - B.commissionAmount - B.commissionGstAmount - 0.5 - 0.1);
  const retained = r2(
    A.commissionAmount + A.commissionGstAmount + 1.0 + 0.2 + B.commissionAmount + B.commissionGstAmount + 0.5 + 0.1,
  );
  console.log(
    `\nworked example, through the live function:` +
    `\n  seller A (gross 236.00, taxable 200.00): commission ${A.commissionAmount.toFixed(2)}` +
    ` + GST ${A.commissionGstAmount.toFixed(2)} + TCS 1.00 + TDS 0.20  ->  net ${netA.toFixed(2)}` +
    `  ${netA === 223 ? "- matches 223.00" : "  MISMATCH"}` +
    `\n  seller B (composition, 100.00):          commission ${B.commissionAmount.toFixed(2)}` +
    ` + GST ${B.commissionGstAmount.toFixed(2)} + TCS 0.50 + TDS 0.10  ->  net ${netB.toFixed(2)}` +
    `  ${netB === 93.5 ? "- matches 93.50" : "  MISMATCH"}` +
    `\n  platform retains ${retained.toFixed(2)}  ${retained === 19.5 ? "- matches 19.50" : "  MISMATCH"}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
