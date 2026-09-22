/**
 * Runbook step 16's prove, run for real and then undone.
 *
 * The unit tests assert that a delivery invoice's SHAPE meets the platform scope and misses the
 * shop's and every seller's. They cannot assert that createDeliveryInvoice actually produces that
 * shape, because it writes through Prisma. Until this runs, that function has never executed — and
 * with noDeliveryCharge currently TRUE on the live store, the first real execution could otherwise
 * be weeks away and would land straight in someone's GST records.
 *
 * So: pick a real past order that genuinely charged a delivery fee, give it the step-15 split it
 * predates, generate the invoice for real, read it back through the SAME scope predicates the
 * reports use, and then remove every trace.
 *
 * ⚠️ IT WRITES TO PRODUCTION AND THEN CLEANS UP. Four things are created and all four are removed:
 * the Invoice, its line item (cascade), the Payment receipt, and the DEL invoice-counter row — that
 * last one matters, because leaving it at 1 after deleting invoice 00001 would put a GAP in a GST
 * series, which is a real defect rather than untidiness. The order's two delivery columns are set
 * and then put back to NULL. The cleanup runs in a `finally`, and the script re-reads everything
 * afterwards to prove the database is as it was found.
 *
 * Run: railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/proveDeliveryInvoice.ts'
 */
import { PrismaClient } from "@prisma/client";
import { generateOrderInvoice } from "../src/services/orderInvoice.js";
import { splitInclusiveDeliveryFee } from "../src/data/deliveryTax.js";
import { scopeFilter, HOUSE_SCOPE, PLATFORM_SCOPE } from "../src/services/reports.js";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL } },
});

async function main() {
  const order = await prisma.order.findFirst({
    where: { deliveryCharge: { gt: 0 }, deliveryTaxable: null },
    select: { id: true, orderNumber: true, deliveryCharge: true, customerId: true, paymentStatus: true },
    orderBy: { createdAt: "desc" },
  });
  if (!order) { console.log("No historical order with a delivery fee — nothing to prove against."); return; }

  // ⚠️ generateOrderInvoice makes GOODS invoices too. On a historical order they are all present
  // already and the idempotency checks skip them — but if even one sub-order were missing its
  // invoice, this run would create a real goods document that the cleanup below does not know to
  // remove. So refuse unless every slice is already invoiced, and the only thing that CAN be
  // created is the delivery invoice.
  const slices = await prisma.subOrder.findMany({ where: { orderId: order.id }, select: { id: true } });
  const invoiced = await prisma.invoice.count({ where: { subOrderId: { in: slices.map((s) => s.id) } } });
  const legacyOk = slices.length === 0
    ? (await prisma.order.findUnique({ where: { id: order.id }, select: { invoiceId: true } }))?.invoiceId != null
    : true;
  if (invoiced !== slices.length || !legacyOk) {
    console.log(`Refusing: order ${order.orderNumber} has ${slices.length} slice(s) but ${invoiced} invoice(s)` +
      ` (legacy invoiceId ${legacyOk ? "present" : "missing"}). This run could create a goods document the` +
      ` cleanup would leave behind.`);
    return;
  }

  const fee = Number(order.deliveryCharge);
  const split = splitInclusiveDeliveryFee(fee);
  console.log(`order ${order.orderNumber} — fee ₹${fee} → taxable ₹${split.taxable} + GST ₹${split.gst}\n`);

  const before = {
    invoices: await prisma.invoice.count(),
    payments: await prisma.payment.count(),
    counters: await prisma.invoiceCounter.count({ where: { prefix: "DEL" } }),
  };

  let invoiceId: string | null = null;
  try {
    // Give the order the split it predates, so the generator has an honest figure to bill.
    await prisma.order.update({
      where: { id: order.id },
      data: { deliveryTaxable: split.taxable, deliveryGst: split.gst },
      select: { id: true },
    });

    await generateOrderInvoice(order.id);

    const inv = await prisma.invoice.findUnique({
      where: { deliveryForOrderId: order.id },
      include: { lineItems: true },
    });
    if (!inv) throw new Error("createDeliveryInvoice produced nothing");
    invoiceId = inv.id;

    const li = inv.lineItems[0];
    console.log("CREATED:");
    console.log(`  ${inv.invoiceNumber}   kind=${inv.invoiceKind}  type=${inv.invoiceType}`);
    console.log(`  sellerId=${inv.sellerId}  supplierName=${inv.supplierName}`);
    console.log(`  subtotal ₹${inv.subtotal}  cgst ₹${inv.totalCgst}  sgst ₹${inv.totalSgst}  total ₹${inv.totalAmount}`);
    console.log(`  line: "${li?.description}"  code=${li?.hsnCode}  unit=${li?.unit}  rate=${li?.gstRate}%`);

    const closes = Number(inv.subtotal) + Number(inv.totalCgst) + Number(inv.totalSgst) + Number(inv.totalIgst);
    console.log(`\n  taxable + tax = ₹${closes.toFixed(2)}  vs fee ₹${fee}  ${closes.toFixed(2) === fee.toFixed(2) ? "CLOSES" : "DOES NOT CLOSE"}`);

    // ── The prove: which GST return does this land in? Asked through the real predicates. ──
    const inScope = async (label: string, where: any) =>
      (await prisma.invoice.count({ where: { id: inv.id, ...where } })) > 0
        ? `${label}: YES` : `${label}: no`;

    const sellers = await prisma.seller.findMany({ select: { id: true, name: true } });
    console.log("\nWHICH RETURN:");
    console.log("  " + await inScope("platform", scopeFilter(PLATFORM_SCOPE)));
    console.log("  " + await inScope("house (the shop)", scopeFilter(HOUSE_SCOPE)));
    for (const s of sellers) {
      console.log("  " + await inScope(`seller ${s.name}`, scopeFilter({ kind: "seller", sellerId: s.id })));
    }

    // Idempotency: a second generate must not produce a second document.
    await generateOrderInvoice(order.id);
    const dupes = await prisma.invoice.count({ where: { deliveryForOrderId: order.id } });
    console.log(`\n  after regenerating: ${dupes} delivery invoice(s) — must be 1`);
  } finally {
    // ── Undo everything, in dependency order. ──
    if (invoiceId) {
      await prisma.payment.deleteMany({ where: { relatedType: "INVOICE", relatedId: invoiceId } });
      await prisma.invoiceLineItem.deleteMany({ where: { invoiceId } });
      await prisma.invoice.delete({ where: { id: invoiceId } });
    }
    // The counter, so the DEL series starts at 00001 for the first REAL delivery invoice rather
    // than at 00002 with a gap where this one was.
    await prisma.invoiceCounter.deleteMany({ where: { prefix: "DEL" } });
    await prisma.order.update({
      where: { id: order.id },
      data: { deliveryTaxable: null, deliveryGst: null },
      select: { id: true },
    });

    const after = {
      invoices: await prisma.invoice.count(),
      payments: await prisma.payment.count(),
      counters: await prisma.invoiceCounter.count({ where: { prefix: "DEL" } }),
    };
    const clean = before.invoices === after.invoices
      && before.payments === after.payments
      && before.counters === after.counters;
    console.log(`\nCLEANUP: invoices ${before.invoices}→${after.invoices}, payments ${before.payments}→${after.payments}, DEL counters ${before.counters}→${after.counters}  ${clean ? "— database as found" : "— ⚠️ NOT CLEAN"}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
