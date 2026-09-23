/**
 * Re-bases the historical sub-orders onto runbook step 07's commission rule.
 *
 * Step 07 changed two things at placement and changed nothing already written:
 *   1. the commission BASE moved from the gross the customer paid to the GST-exclusive taxable
 *      value — the platform's fee is for selling the goods, not for collecting the government's tax;
 *   2. the 18% GST on that commission (SAC 998599) became something WITHHELD from the payout rather
 *      than a receivable the platform had to chase.
 *
 * scripts/proveCommissionBase.ts printed what re-basing the existing book would move and
 * deliberately wrote nothing, so that standing put stayed a decision somebody made. This is that
 * decision, taken: the owner asked for the historical rows to follow the new rule.
 *
 * ⚠️ WHY THIS IS SAFE TO RUN, and every condition is checked at run time rather than assumed:
 *   1. NOTHING HAS BEEN PAID OUT. Every affected slice must be settled = false. Re-basing a slice
 *      whose money has already left is a clawback and a conversation, not a column edit. REFUSES.
 *   2. NO COMMISSION INVOICE HAS BEEN RAISED over these rows. A commission invoice bills a taxable
 *      value and snapshots the GST onto the slices it covers; moving the commission underneath one
 *      already issued would leave a document billing a number its own rows no longer support.
 *      REFUSES if any COMMISSION invoice exists.
 *   3. NOTHING HAS BEEN FILED for any affected period, on either return. A filed return is
 *      corrected by amendment, not by rewriting the rows it was built from. REFUSES.
 *
 * ⚠️ HOUSE SLICES ARE EXCLUDED, explicitly, by `isHouse: false` — NOT by whatever
 * StoreConfig.houseSellerIsSeparateEntity happens to say when this runs. This script is about the
 * step-07 base change and nothing else. The house store was the same legal entity as the platform
 * when those 347 slices were placed, so it owed no commission on them; step 23 splitting the
 * entities later does not reach back and start charging for orders taken before the split. Reading
 * the flag here would silently make the run date decide what a seller owes.
 *
 * ⚠️ PER-PRODUCT OVERRIDES ARE DELIBERATELY IGNORED (every line is resolved at the slice's own
 * stored commissionPct). Step 20 lets a rate be negotiated per product; an override agreed LAST
 * WEEK must not reach back and restate what an order from last month was charged. The recomputed
 * blended rate is asserted equal to the stored one, so if that assumption ever stops holding the
 * script refuses instead of quietly applying a newer rate.
 *
 * Dry run:  railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/repairCommissionBase.ts'
 * Apply:    ... same, with --apply
 *
 * Idempotent: it only selects rows still carrying a NULL commissionGstAmount, which is the marker
 * for "placed before step 07". A second run finds nothing.
 */
import { PrismaClient } from "@prisma/client";
import { sumSellerLines } from "../src/services/sellerSplit.js";
import { computeSellerSplit } from "../src/services/sellerSplit.js";
import { COMMISSION_GST_RATE_PCT } from "../src/data/commissionTax.js";
import { RETURN_TYPES, periodOf, filedAt } from "../src/services/filedPeriods.js";
import { INVOICE_KIND } from "../src/data/invoiceKinds.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

const APPLY = process.argv.includes("--apply");
const n = (v: unknown) => Number(v ?? 0);
/** The split's own rounding. Not round2 — see services/sellerSplit.ts. */
const r2 = (v: number) => +v.toFixed(2);

/** The balance the ledger derives from live slices — the same predicate payouts use. */
async function derivedOwed(sellerId: string): Promise<number> {
  const agg = await prisma.subOrder.aggregate({
    _sum: { netPayable: true },
    where: { sellerId, settled: false, status: { not: "CANCELLED" }, order: { status: { not: "CANCELLED" } } },
  });
  return r2(n(agg._sum.netPayable));
}

async function main() {
  console.log(APPLY ? "MODE: APPLY (will write)" : "MODE: DRY RUN (no writes)");
  console.log(`Re-basing commission onto taxableValue, and withholding ${COMMISSION_GST_RATE_PCT}% GST on it.\n`);

  const rows = await prisma.subOrder.findMany({
    where: {
      commissionGstAmount: null,
      seller: { is: { isHouse: false } },
      status: { not: "CANCELLED" },
      order: { is: { status: { not: "CANCELLED" } } },
    },
    select: {
      id: true, sellerId: true, settled: true, status: true, createdAt: true,
      subtotal: true, taxableValue: true, commissionPct: true, commissionAmount: true,
      tcsRatePct: true, tcsAmount: true, tdsAmount: true, netPayable: true,
      seller: { select: { name: true, isHouse: true } },
      order: { select: { orderNumber: true, status: true } },
      items: { select: { lineTotal: true, taxableValue: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const houseLeft = await prisma.subOrder.count({
    where: { commissionGstAmount: null, seller: { is: { isHouse: true } }, status: { not: "CANCELLED" } },
  });
  if (houseLeft > 0) {
    console.log(
      `${houseLeft} house slice(s) left alone on purpose — the shop and the platform were one legal\n` +
      `entity when they were placed, so they owed no commission and no GST on one. See the note in\n` +
      `this file; step 23 splitting the entities does not reach backwards.\n`,
    );
  }

  if (rows.length === 0) { console.log("No pre-step-07 external-seller slices left. Already re-based."); return; }

  // Refusals ---------------------------------------------------------------------------------
  const settled = rows.filter((r) => r.settled);
  if (settled.length > 0) {
    throw new Error(
      `${settled.length} affected slice(s) are already settled — the seller was PAID on the old base. ` +
      `That needs a credit note and a conversation, not a column edit. Refusing.`,
    );
  }

  const commissionInvoices = await prisma.invoice.count({ where: { invoiceKind: INVOICE_KIND.COMMISSION } });
  if (commissionInvoices > 0) {
    throw new Error(
      `${commissionInvoices} commission invoice(s) already exist. One of them bills a taxable value ` +
      `these rows would no longer support, and it has already snapshotted its own GST onto them. ` +
      `Correct by credit note, not by moving the rows underneath. Refusing.`,
    );
  }

  for (const period of new Set(rows.map((r) => periodOf(r.createdAt)))) {
    for (const rt of [RETURN_TYPES.GSTR1, RETURN_TYPES.GSTR8]) {
      const filed = await filedAt(rt, period);
      if (filed) {
        throw new Error(
          `${rt} for ${period} was filed on ${filed.toISOString()} and contains affected rows. ` +
          `A filed return is corrected by amendment, not by rewriting its rows. Refusing.`,
        );
      }
    }
  }

  // The correction, row by row ---------------------------------------------------------------
  const sellerIds = [...new Set(rows.map((r) => r.sellerId))];
  const before = new Map<string, { stored: number; derived: number }>();
  for (const sid of sellerIds) {
    const s = await prisma.seller.findUnique({ where: { id: sid }, select: { outstandingBalance: true } });
    before.set(sid, { stored: r2(n(s?.outstandingBalance)), derived: await derivedOwed(sid) });
  }

  type Plan = {
    id: string; sellerId: string; counted: boolean;
    oldC: number; newC: number; newGst: number; newPct: number; oldNet: number; newNet: number;
  };
  const planned: Plan[] = [];

  console.log(`${rows.length} external-seller slice(s) placed before step 07:\n`);
  for (const r of rows) {
    if (r.items.length === 0) {
      throw new Error(`${r.order.orderNumber}: slice has no items — cannot re-derive a commission. Refusing.`);
    }
    // ⚠️ Overrides deliberately not read — see the note at the top of this file.
    const lines = r.items.map((i) => ({ lineTotal: n(i.lineTotal), taxableValue: n(i.taxableValue) }));
    const t = sumSellerLines(lines, n(r.commissionPct));
    const split = computeSellerSplit({
      subtotal: t.subtotal,
      taxableValue: t.taxableValue,
      commissionPct: t.commissionPct,
      commissionAmount: t.commissionAmount,
      commissionGstAmount: t.commissionGstAmount,
      // ⚠️ The STORED rate, never today's constant. Step 06 already corrected these rows to 0.5%;
      // re-deriving TCS from the current constant here would restate a second thing silently.
      tcsRatePct: n(r.tcsRatePct),
      tdsAmount: n(r.tdsAmount),
      isHouse: false,
    });

    // Three assertions, because this run must move the commission and NOTHING ELSE. Each one is a
    // way the re-derivation could quietly disagree with what is stored.
    if (r2(split.subtotal) !== r2(n(r.subtotal))) {
      throw new Error(
        `${r.order.orderNumber}: items sum to ${split.subtotal.toFixed(2)} but the slice stores ` +
        `${n(r.subtotal).toFixed(2)}. The lines and the slice disagree. Refusing.`,
      );
    }
    if (r2(split.taxableValue) !== r2(n(r.taxableValue))) {
      throw new Error(
        `${r.order.orderNumber}: items' taxable value sums to ${split.taxableValue.toFixed(2)} but the ` +
        `slice stores ${n(r.taxableValue).toFixed(2)} — an item is probably missing one. Refusing.`,
      );
    }
    if (r2(split.tcsAmount) !== r2(n(r.tcsAmount))) {
      throw new Error(
        `${r.order.orderNumber}: TCS re-derives to ${split.tcsAmount.toFixed(2)} but ${n(r.tcsAmount).toFixed(2)} ` +
        `is stored. This script must not move TCS. Refusing.`,
      );
    }
    if (r2(split.commissionPct) !== r2(n(r.commissionPct))) {
      throw new Error(
        `${r.order.orderNumber}: the blended rate re-derives to ${split.commissionPct}% but ${n(r.commissionPct)}% ` +
        `is stored — a per-product override agreed since would be applied retroactively. Refusing.`,
      );
    }

    const counted = !r.settled && r.status !== "CANCELLED" && r.order.status !== "CANCELLED";
    planned.push({
      id: r.id, sellerId: r.sellerId, counted,
      oldC: n(r.commissionAmount), newC: split.commissionAmount, newGst: split.commissionGstAmount,
      newPct: split.commissionPct, oldNet: n(r.netPayable), newNet: split.netPayable,
    });
    console.log(
      `  ${r.order.orderNumber}  ${r.seller.name.padEnd(20)} gross=${n(r.subtotal).toFixed(2).padStart(8)}` +
      ` taxable=${n(r.taxableValue).toFixed(2).padStart(8)}   commission ${n(r.commissionAmount).toFixed(2)} -> ` +
      `${split.commissionAmount.toFixed(2)}  +GST ${split.commissionGstAmount.toFixed(2)}   ` +
      `net ${n(r.netPayable).toFixed(2)} -> ${split.netPayable.toFixed(2)}${counted ? "" : "   (not in balance)"}`,
    );
  }

  const oldCommission = r2(planned.reduce((t, p) => t + p.oldC, 0));
  const newCommission = r2(planned.reduce((t, p) => t + p.newC, 0));
  const gstNowWithheld = r2(planned.reduce((t, p) => t + p.newGst, 0));
  const bySeller = new Map<string, number>();
  for (const p of planned) {
    if (!p.counted) continue;
    bySeller.set(p.sellerId, r2((bySeller.get(p.sellerId) ?? 0) + (p.newNet - p.oldNet)));
  }

  console.log(
    `\ncommission  ${oldCommission.toFixed(2)} -> ${newCommission.toFixed(2)}  ` +
    `(${r2(newCommission - oldCommission) >= 0 ? "+" : ""}${r2(newCommission - oldCommission).toFixed(2)}  ` +
    `— the tax the customer paid is no longer part of the platform's fee base)` +
    `\nGST on that commission, previously a receivable, now withheld: ${gstNowWithheld.toFixed(2)}`,
  );
  for (const [sid, delta] of bySeller) {
    const b = before.get(sid)!;
    const name = rows.find((r) => r.sellerId === sid)!.seller.name;
    console.log(
      `  ${name}: outstandingBalance ${b.stored.toFixed(2)} -> ${r2(b.stored + delta).toFixed(2)}  ` +
      `(${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`,
    );
  }

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); return; }

  await prisma.$transaction(async (tx) => {
    for (const p of planned) {
      await tx.subOrder.update({
        where: { id: p.id },
        data: {
          commissionPct: p.newPct,
          commissionAmount: p.newC,
          commissionGstPct: p.newC > 0 ? COMMISSION_GST_RATE_PCT : 0,
          commissionGstAmount: p.newGst,
          netPayable: p.newNet,
        },
        select: { id: true },
      });
    }
    for (const [sid, delta] of bySeller) {
      await tx.seller.update({ where: { id: sid }, data: { outstandingBalance: { increment: delta } }, select: { id: true } });
    }
  });

  // Verify by re-reading, not by trusting the writes ------------------------------------------
  console.log("\n--- after ---");
  const left = await prisma.subOrder.count({
    where: {
      commissionGstAmount: null,
      seller: { is: { isHouse: false } },
      status: { not: "CANCELLED" },
      order: { is: { status: { not: "CANCELLED" } } },
    },
  });
  console.log(`  external slices still un-re-based: ${left}${left === 0 ? "  — none" : "  WARNING"}`);
  for (const sid of sellerIds) {
    const s = await prisma.seller.findUnique({ where: { id: sid }, select: { name: true, outstandingBalance: true } });
    const b = before.get(sid)!;
    const stored = r2(n(s?.outstandingBalance));
    const derived = await derivedOwed(sid);
    const driftBefore = r2(b.stored - b.derived);
    const driftAfter = r2(stored - derived);
    console.log(
      `  ${s?.name}: stored ${b.stored.toFixed(2)} -> ${stored.toFixed(2)}, derived ${b.derived.toFixed(2)} -> ${derived.toFixed(2)}, ` +
      `drift ${driftBefore.toFixed(2)} -> ${driftAfter.toFixed(2)}  ` +
      `${Math.abs(driftAfter - driftBefore) < 0.005 ? "— unchanged, as intended" : "WARNING: THE FIX MOVED THE DRIFT"}`,
    );
  }
}

main().catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); }).finally(() => prisma.$disconnect());
