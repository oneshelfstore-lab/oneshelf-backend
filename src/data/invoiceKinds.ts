/**
 * WHOSE supply an invoice documents. One definition, because three different services have to agree
 * on the strings or an invoice silently lands in the wrong GST return.
 *
 * ⚠️ These are WIRE VALUES — they are persisted in `Invoice.invoiceKind` on every row. Add a kind,
 * never rename one: a rename orphans every invoice written under the old spelling, and the orphan
 * shows up as income missing from a filed return rather than as an error.
 *
 * The column is a String rather than a Postgres enum (same reasoning as `Seller.vertical`), so
 * adding a kind here needs no migration.
 *
 * The three identities, and why they cannot share a return:
 *
 *   GOODS       a seller supplying a customer. Belongs in THAT seller's GSTR-1 — the house store's
 *               for its own stock, an external seller's for theirs.
 *   COMMISSION  the platform billing a seller for its marketplace service (SAC 998599 @ 18%).
 *               Platform income. Putting it in the shop's return declares the shop earned it.
 *   DELIVERY    the platform supplying delivery to the customer (a SAC, not an HSN). Also platform
 *               income, and also not the shop's.
 *
 * Today the platform and the shop are one legal entity, so the platform scope is empty and
 * everything is GOODS. `StoreConfig.houseSellerIsSeparateEntity` (step 23) is what splits them.
 */
export const INVOICE_KIND = {
  /** A seller's supply of goods to a customer. Every invoice issued before Sep 2026 is one. */
  GOODS: "GOODS",
  /** Platform → seller, for marketplace commission. */
  COMMISSION: "COMMISSION",
  /** Platform → customer, for the delivery fee. */
  DELIVERY: "DELIVERY",
} as const;

export type InvoiceKind = (typeof INVOICE_KIND)[keyof typeof INVOICE_KIND];

/** The kinds the PLATFORM issues as itself — i.e. everything that is not somebody's goods. */
export const PLATFORM_INVOICE_KINDS: readonly InvoiceKind[] = [
  INVOICE_KIND.COMMISSION,
  INVOICE_KIND.DELIVERY,
];
