import prisma from "../lib/prisma.js";
import { getNextOrderNumber } from "./orderNumbering.js";
import { generateOrderInvoice } from "./orderInvoice.js";
import { notifyNewOrder } from "./fcmNotifier.js";
import { generateOtp, orderRequiresOtp } from "../lib/otp.js";

// ─── Bulk Express: materialize an approved QuoteRequest into a real Order ───────────────────────
// This is what connects bulk orders to the delivery pipeline. Before this, an approved/paid quote
// just sat in the QuoteRequest table and the owner flipped it to FULFILLED by hand — no Order, so
// no delivery-agent feed, no OTP handover, no invoice, no stock movement.
//
// Once a quote becomes ACCEPTED (the customer approved a QUOTED price — paid online OR pay-on-
// delivery), we create one house Order from its priced line items. It then flows through the exact
// same owner board / delivery dashboard / OTP handover / invoice path as a normal order.
//
// Idempotent: guarded by Order.quoteRequestId @unique + the quote's own orderId back-link, so the
// two call sites (pay-on-delivery approve AND payment confirmation) can both fire safely.

export interface MaterializeResult {
  orderId: string;
  created: boolean;
  warnings: string[];
}

/**
 * Convert an ACCEPTED quote into a fulfillment Order. Returns the existing order id if already
 * converted (idempotent). Best-effort stock decrement for owner-mapped variant lines; free-text
 * lines never touch inventory. Never throws on the post-create steps (invoice/notify); a failure
 * there leaves a valid order behind.
 */
export async function materializeQuoteOrder(quoteId: string): Promise<MaterializeResult | null> {
  const quote = await prisma.quoteRequest.findUnique({
    where: { id: quoteId },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
  if (!quote) return null;

  // Already converted → return the existing order (idempotent for the two call sites).
  if (quote.orderId) {
    const existing = await prisma.order.findUnique({ where: { id: quote.orderId }, select: { id: true } });
    if (existing) return { orderId: existing.id, created: false, warnings: [] };
  }
  const byLink = await prisma.order.findUnique({ where: { quoteRequestId: quote.id }, select: { id: true } });
  if (byLink) return { orderId: byLink.id, created: false, warnings: [] };

  // Only ACCEPTED quotes (the customer approved a sent price) become orders.
  if (quote.status !== "ACCEPTED") return null;
  // Nothing to fulfill without priced line items.
  if (quote.items.length === 0) return null;

  const warnings: string[] = [];

  const subtotal = +quote.items.reduce((s, it) => s + Number(it.amount), 0).toFixed(2);
  const deliveryCharge = quote.deliveryFee != null ? Number(quote.deliveryFee) : 0;
  const total = quote.quotedAmount != null ? Number(quote.quotedAmount) : +(subtotal + deliveryCharge).toFixed(2);
  const amountPaid = quote.amountPaid != null ? Number(quote.amountPaid) : 0;

  // Payment shape on the Order. The money truth stays on the QuoteRequest; the Order's
  // method/status just tell the delivery agent what (if anything) to collect.
  //   PAID         → fully paid online, collect nothing.
  //   ADVANCE_PAID → advance captured, agent collects (total − amountPaid) on delivery.
  //   else         → pay-on-delivery, agent collects the full total.
  let paymentMethod: "ONLINE" | "COD";
  let paymentStatus: "PAID" | "ADVANCE_PAID" | "PENDING";
  if (quote.paymentStatus === "PAID") {
    paymentMethod = "ONLINE";
    paymentStatus = "PAID";
  } else if (quote.paymentStatus === "ADVANCE_PAID") {
    paymentMethod = "COD";
    paymentStatus = "ADVANCE_PAID";
  } else {
    paymentMethod = "COD";
    paymentStatus = "PENDING";
  }

  const needsOtp = orderRequiresOtp(paymentStatus, total);

  // The house seller fulfils bulk orders. A single house sub-order keeps the order consistent with
  // the marketplace pipeline (delivery treats house sub-orders as auto-collected → no collection run).
  const houseSeller = await prisma.seller.findFirst({
    where: { isHouse: true },
    select: { id: true, commissionPct: true },
  });

  // Snapshot the delivery address: the one the customer chose at approval (quote.addressId, validated
  // to be theirs when stored), else their default, else any saved address. Owner has their phone too.
  const address =
    (quote.addressId
      ? await prisma.address.findFirst({ where: { id: quote.addressId, userId: quote.userId } })
      : null) ??
    (await prisma.address.findFirst({ where: { userId: quote.userId, isDefault: true } })) ??
    (await prisma.address.findFirst({ where: { userId: quote.userId } }));

  const customer = await prisma.user.findUnique({
    where: { id: quote.userId },
    select: { name: true, phone: true },
  });

  // Resolve mapped variants (optional SKU link) so we can snapshot sku/image/hsn + decrement stock.
  const mappedVariantIds = quote.items.map((it) => it.variantId).filter((v): v is string => !!v);
  const variants = mappedVariantIds.length
    ? await prisma.productVariant.findMany({
        where: { id: { in: mappedVariantIds } },
        include: { product: { select: { name: true, hsnCode: true, imageUrls: true } } },
      })
    : [];
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const orderNumber = await getNextOrderNumber();

  const noteParts: string[] = [`Bulk order (${quote.type})`];
  if (quote.note?.trim()) noteParts.push(quote.note.trim());
  if (quote.eventDate?.trim()) noteParts.push(`Needed by ${quote.eventDate.trim()}`);
  if (paymentStatus === "ADVANCE_PAID") {
    noteParts.push(`Advance ₹${amountPaid.toFixed(0)} paid online — collect balance ₹${(total - amountPaid).toFixed(0)} on delivery.`);
  }

  const order = await prisma.$transaction(async (tx) => {
    // Best-effort stock decrement for owner-mapped variant lines. The qty is free-text ("5kg", "2 pkt",
    // "3"), so we decrement the leading number from it (default 1) — close enough for the owner's rough
    // bulk inventory tracking. Insufficient stock never fails the order (the quote was already
    // approved/paid); if stock is short we decrement what's available and warn the owner.
    for (const it of quote.items) {
      if (!it.variantId) continue;
      const qtyMatch = (it.qty ?? "").match(/[\d.]+/);
      let want = qtyMatch ? Math.ceil(parseFloat(qtyMatch[0])) : 1;
      if (!Number.isFinite(want) || want < 1) want = 1;
      // Decrement up to what's in stock (clamped), so a too-large bulk qty doesn't fail or oversell.
      const variant = await tx.productVariant.findUnique({ where: { id: it.variantId }, select: { stock: true, isActive: true } });
      const available = variant && variant.isActive ? Math.floor(Number(variant.stock)) : 0;
      const take = Math.min(want, available);
      if (take > 0) {
        await tx.productVariant.updateMany({
          where: { id: it.variantId, stock: { gte: take } },
          data: { stock: { decrement: take } },
        });
      }
      if (take < want) warnings.push(`Stock short for "${it.name}": needed ${want}, deducted ${take}.`);
    }

    const created = await tx.order.create({
      data: {
        orderNumber,
        customerId: quote.userId,
        status: "CONFIRMED", // lands on the owner board; owner packs → PACKED → delivery feed
        fulfillmentType: "DELIVERY",
        paymentMethod,
        paymentStatus,
        source: "BULK_QUOTE",
        quoteRequestId: quote.id,
        addressId: address?.id,
        shippingName: customer?.name,
        shippingPhone: customer?.phone,
        shippingAddress: address?.addressLine,
        shippingPincode: address?.pincode,
        subtotal,
        discount: 0,
        deliveryCharge,
        taxableValue: 0, // owner-priced bulk lines carry no per-line GST split (⚠️ GST/CA: bulk invoice tax)
        totalTax: 0,
        totalAmount: total,
        amountPaid,
        savedAmount: 0,
        deliveryOtpRequired: needsOtp,
        notes: noteParts.join(" · ").slice(0, 500),
        items: {
          create: quote.items.map((it) => {
            const v = it.variantId ? variantById.get(it.variantId) : undefined;
            const lineTotal = Number(it.amount);
            return {
              variantId: v ? it.variantId : null,
              productName: it.name,
              variantSku: v?.sku ?? "BULK",
              imageUrl: v?.product.imageUrls?.[0] ?? null,
              hsnCode: v?.product.hsnCode ?? null,
              unitPrice: lineTotal, // qty is free-text → treat the priced amount as a single line
              quantity: 1,
              lineTotal,
              sellerId: houseSeller?.id ?? null,
            };
          }),
        },
      },
      include: { items: true },
    });

    if (needsOtp) {
      await tx.orderSecret.create({
        data: { orderId: created.id, otp: generateOtp(), customerId: quote.userId, fulfillmentType: "DELIVERY" },
      });
    }

    // One house sub-order grouping every line (house = 0 commission / 0 TCS / netPayable = subtotal).
    if (houseSeller) {
      const sub = await tx.subOrder.create({
        data: {
          orderId: created.id,
          sellerId: houseSeller.id,
          status: "PLACED", // matches normal placement; house-only orders never use the collection run
          subtotal,
          commissionPct: Number(houseSeller.commissionPct ?? 0),
          commissionAmount: 0,
          tcsAmount: 0,
          netPayable: subtotal,
        },
      });
      await tx.orderItem.updateMany({
        where: { id: { in: created.items.map((i) => i.id) } },
        data: { subOrderId: sub.id },
      });
    }

    // Link the quote → order (idempotency back-link). Keep the quote ACCEPTED.
    await tx.quoteRequest.update({ where: { id: quote.id }, data: { orderId: created.id } });

    return created;
  });

  // Post-create, best-effort — never strand a valid order on a side-effect failure.
  generateOrderInvoice(order.id).catch((e) => console.error("Bulk invoice generation failed:", e));
  notifyNewOrder({
    id: order.id,
    orderNumber: order.orderNumber,
    totalAmount: order.totalAmount,
    customerId: order.customerId,
  }).catch(() => {});

  return { orderId: order.id, created: true, warnings };
}
