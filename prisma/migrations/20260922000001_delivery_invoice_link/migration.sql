-- Runbook step 16: the platform's delivery invoice.
--
-- One nullable column plus its unique index. Nullable because every invoice that exists today is a
-- goods invoice and has no delivery order to point at; a UNIQUE index treats NULLs as distinct in
-- Postgres, so all 374 existing rows coexist under it without a backfill.
--
-- ⚠️ The uniqueness is the reason the column exists. generateOrderInvoice is reachable from eight
-- call sites, is built to be idempotent, and gets that idempotency for goods invoices from
-- Invoice.subOrderId's unique constraint. Without an equivalent here the delivery invoice would be
-- a read-then-write race between, say, a seller marking an order packed and markOrderPaid firing —
-- and its failure mode is a duplicate GST document inside a filed return. The constraint makes that
-- impossible rather than unlikely.
ALTER TABLE "Invoice" ADD COLUMN     "deliveryForOrderId" TEXT;
CREATE UNIQUE INDEX "Invoice_deliveryForOrderId_key" ON "Invoice"("deliveryForOrderId");
