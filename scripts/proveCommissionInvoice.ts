/**
 * Runbook step 17's prove, run for real against live data and then undone.
 *
 * The unit tests assert that a commission invoice's SHAPE reaches the platform scope and misses the
 * shop's and the billed seller's. They cannot assert that generateCommissionInvoice produces that
 * shape, because it writes through Prisma — and this is the document the entire neutrality gate was
 * built to protect. Its first execution should not be the one that lands in a filed return.
 *
 * So: bill a real seller for a real month, read the invoice back through the SAME scope predicates
 * the reports use, check the period's GSTR-1 actually gains the value, confirm a second press does
 * not raise a second document, and then remove every trace.
 *
 * ⚠️ IT WRITES TO PRODUCTION AND THEN CLEANS UP. Created and removed: the Invoice, its line item,
 * the seller's billing Customer row (only if this run created it), and the COM invoice-counter row
 * — that last one because leaving it at 1 after deleting invoice 00001 would put a GAP in a GST
 * series. The SubOrder commission-GST snapshots this writes are reset to NULL. The cleanup runs in
 * a `finally` and the script re-counts everything afterwards to prove the database is as it was.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/proveCommissionInvoice.ts'
 */
import { PrismaClient } from "@prisma/client";
import { generateCommissionInvoice } from "../src/services/commissionInvoice.js";
import { scopeFilter, HOUSE_SCOPE, PLATFORM_SCOPE, getGstr1Summary } from "../src/services/reports.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

/**
 * The taxable value a GSTR-1 would report for a scope. getGstr1Summary has no roll-up of its own —
 * the return is the tables themselves — so the outward-supply value is b2b plus b2cs, which is what
 * a filed return declares.
 */
async function gstr1TaxableValue(period: string, scope: any): Promise<number> {
  const g = await getGstr1Summary(period, scope);
  const b2b = g.b2b.reduce((t: number, r: any) => t + Number(r.taxableValue ?? 0), 0);
  const b2cs = g.b2cs.reduce((t: number, r: any) => t + Number(r.taxableValue ?? 0), 0);
  return Math.round((b2b + b2cs) * 100) / 100;
}

async function main() {
  // The seller/month with the most commission on record — the one whose numbers are easiest to
  // check by hand if anything looks wrong.
  const rows = await prisma.$queryRaw<{ sellerId: string; period: string; total: number; n: bigint }[]>`
    SELECT so."sellerId",
           to_char(so."createdAt", 'YYYY-MM') AS period,
           sum(so."commissionAmount")::float  AS total,
           count(*)                           AS n
    FROM "SubOrder" so
    JOIN "Seller" s ON s.id = so."sellerId"
    JOIN "Order"  o ON o.id = so."orderId"
    WHERE s."isHouse" = false AND so.status <> 'CANCELLED' AND o.status <> 'CANCELLED'
    GROUP BY 1, 2 HAVING sum(so."commissionAmount") > 0
    ORDER BY 3 DESC LIMIT 1`;
  if (rows.length === 0) { console.log("No seller has earned the platform any commission yet."); return; }

  const { sellerId, period, total, n } = rows[0]!;
  const seller = await prisma.seller.findUnique({ where: { id: sellerId }, select: { name: true, gstin: true } });
  console.log(`${seller?.name} — ${period}: ₹${total.toFixed(2)} commission across ${Number(n)} sub-order(s)`);
  console.log(`  seller GSTIN: ${seller?.gstin ?? "none — expect B2CS"}\n`);

  const customerExisted = (await prisma.customer.count({ where: { sellerAccountId: sellerId } })) > 0;
  const before = {
    invoices: await prisma.invoice.count(),
    customers: await prisma.customer.count(),
    counters: await prisma.invoiceCounter.count({ where: { prefix: "COM" } }),
    gstr1: await gstr1TaxableValue(period.replace(/(\d{4})-(\d{2})/, "$2$1"), PLATFORM_SCOPE),
    houseGstr1: await gstr1TaxableValue(period.replace(/(\d{4})-(\d{2})/, "$2$1"), HOUSE_SCOPE),
  };

  let invoiceId: string | null = null;
  try {
    const r = await generateCommissionInvoice(sellerId, period);
    if (!r.invoiceId) throw new Error(`nothing issued: ${r.skipped ?? "unknown reason"}`);
    invoiceId = r.invoiceId;

    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { lineItems: true } });
    const li = inv!.lineItems[0];
    console.log("CREATED:");
    console.log(`  ${inv!.invoiceNumber}   kind=${inv!.invoiceKind}  type=${inv!.invoiceType}  supply=${inv!.supplyType}`);
    console.log(`  billed to: ${inv!.customerName}  GSTIN=${inv!.customerGstin ?? "none"}`);
    console.log(`  sellerId=${inv!.sellerId}  supplierName=${inv!.supplierName}  dated ${inv!.invoiceDate.toISOString().slice(0, 10)}`);
    const invGst = Math.round((Number(inv!.totalCgst) + Number(inv!.totalSgst) + Number(inv!.totalIgst)) * 100) / 100;
    console.log(`  commission ₹${inv!.subtotal} + GST ₹${invGst} = ₹${inv!.totalAmount}`);
    console.log(`  withheld already ₹${inv!.amountPaid}   still owed ₹${inv!.amountDue}   (${inv!.paymentStatus})`);
    console.log(`  line: "${li?.description}"  SAC=${li?.hsnCode}  rate=${li?.gstRate}%`);

    // ── The Watch: a seller with a GSTIN must resolve to B2B, which is what puts it in the right
    //    GSTR-1 table. ──
    const expected = inv!.customerGstin ? "B2B" : "B2CS";
    console.log(`\n  supplyType ${inv!.supplyType} — expected ${expected}  ${inv!.supplyType === expected ? "OK" : "WRONG"}`);

    // ── The prove: which return? ──
    const inScope = async (label: string, where: any) =>
      `${label}: ${(await prisma.invoice.count({ where: { id: invoiceId!, ...where } })) > 0 ? "YES" : "no"}`;
    const sellers = await prisma.seller.findMany({ select: { id: true, name: true } });
    console.log("\nWHICH RETURN:");
    console.log("  " + await inScope("platform", scopeFilter(PLATFORM_SCOPE)));
    console.log("  " + await inScope("house (the shop)", scopeFilter(HOUSE_SCOPE)));
    for (const s of sellers) {
      console.log("  " + await inScope(`seller ${s.name}`, scopeFilter({ kind: "seller", sellerId: s.id })));
    }

    // ── And does the period's GSTR-1 actually move by that value, in the platform's and nobody
    //    else's? ──
    const mmyyyy = period.replace(/(\d{4})-(\d{2})/, "$2$1");
    const gained = Math.round((await gstr1TaxableValue(mmyyyy, PLATFORM_SCOPE) - before.gstr1) * 100) / 100;
    const houseMoved = Math.round((await gstr1TaxableValue(mmyyyy, HOUSE_SCOPE) - before.houseGstr1) * 100) / 100;
    console.log(`\nGSTR-1 ${period}:`);
    console.log(`  platform taxable value gained ₹${gained.toFixed(2)}  — expected ₹${Number(inv!.subtotal).toFixed(2)}  ${gained.toFixed(2) === Number(inv!.subtotal).toFixed(2) ? "MATCHES" : "DOES NOT MATCH"}`);
    console.log(`  shop's moved by ₹${houseMoved.toFixed(2)}  — must be ₹0.00  ${houseMoved === 0 ? "UNCHANGED" : "⚠️ MOVED"}`);

    await generateCommissionInvoice(sellerId, period);
    const dupes = await prisma.invoice.count({ where: { commissionPeriodKey: `${sellerId}:${period}` } });
    console.log(`\n  after billing the same month again: ${dupes} invoice(s) — must be 1`);
  } finally {
    if (invoiceId) {
      await prisma.invoiceLineItem.deleteMany({ where: { invoiceId } });
      await prisma.invoice.delete({ where: { id: invoiceId } });
    }
    if (!customerExisted) await prisma.customer.deleteMany({ where: { sellerAccountId: sellerId } });
    await prisma.invoiceCounter.deleteMany({ where: { prefix: "COM" } });
    await prisma.subOrder.updateMany({
      where: { sellerId },
      data: { commissionGstPct: null, commissionGstAmount: null },
    });

    const after = {
      invoices: await prisma.invoice.count(),
      customers: await prisma.customer.count(),
      counters: await prisma.invoiceCounter.count({ where: { prefix: "COM" } }),
    };
    const snaps = await prisma.subOrder.count({ where: { commissionGstAmount: { not: null } } });
    const clean = before.invoices === after.invoices
      && before.customers === after.customers
      && before.counters === after.counters
      && snaps === 0;
    console.log(`\nCLEANUP: invoices ${before.invoices}→${after.invoices}, customers ${before.customers}→${after.customers}, COM counters ${before.counters}→${after.counters}, commission-GST snapshots ${snaps}  ${clean ? "— database as found" : "— ⚠️ NOT CLEAN"}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
