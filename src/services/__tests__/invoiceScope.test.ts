import { describe, it, expect } from "vitest";
import { scopeFilter, HOUSE_SCOPE, PLATFORM_SCOPE, type InvoiceScope } from "../reports.js";
import { INVOICE_KIND, PLATFORM_INVOICE_KINDS } from "../../data/invoiceKinds.js";

/**
 * The scope predicate decides WHOSE GST return an invoice appears in. Every way it can be wrong is
 * silent: the report still renders, the totals still add up, and the error only surfaces as income
 * that belongs to someone else sitting in a filed return. So each rule gets a test, and each test
 * says which filing it protects.
 *
 * Read with the neutrality gate (scripts/reportScopeSnapshot.ts), which proves the CURRENT data is
 * unmoved. These assertions are the other half: they prove the rule stays right for data that does
 * not exist yet — the commission and delivery invoices steps 16 and 17 will start issuing.
 */
describe("scopeFilter — three identities, never mixed", () => {
  it("house takes the store's own GOODS, and only goods", () => {
    // Both halves matter. Drop `invoiceKind` and a platform commission invoice — which has no seller
    // supplier-snapshot either — lands in the shop's GSTR-1 as the shop's own income.
    expect(scopeFilter(HOUSE_SCOPE)).toEqual({
      invoiceKind: INVOICE_KIND.GOODS,
      supplierName: null,
    });
  });

  it("house keys on the supplier snapshot, NOT on sellerId being null", () => {
    // A marketplace house invoice carries the HOUSE SELLER's id, so `sellerId: null` would drop the
    // store's own marketplace sales out of its own return. This is a regression that has happened
    // once already (COMPLIANCE_PLAN.md P0-2).
    expect(scopeFilter(HOUSE_SCOPE)).not.toHaveProperty("sellerId");
  });

  it("a seller scope takes that seller's GOODS, not what the platform billed them", () => {
    const f = scopeFilter({ kind: "seller", sellerId: "s1" });
    expect(f).toEqual({ invoiceKind: INVOICE_KIND.GOODS, sellerId: "s1" });
    // The mirror of the house rule: a commission invoice names the seller it bills, so without the
    // kind test that seller's own GSTR-1 would report the platform's income as their outward supply.
    expect(f.invoiceKind).toBe(INVOICE_KIND.GOODS);
  });

  it("platform takes commission and delivery, and no goods at all", () => {
    const f = scopeFilter(PLATFORM_SCOPE) as { invoiceKind: { in: readonly string[] } };
    expect(f.invoiceKind.in).toEqual([INVOICE_KIND.COMMISSION, INVOICE_KIND.DELIVERY]);
    expect(f.invoiceKind.in).not.toContain(INVOICE_KIND.GOODS);
    // No seller/supplier term: the platform's income is its own whoever it was billed to.
    expect(f).not.toHaveProperty("sellerId");
    expect(f).not.toHaveProperty("supplierName");
  });

  it("the goods scopes and the platform scope cannot both match one invoice", () => {
    // The real safety property, stated as a property rather than three separate shapes: an invoice
    // has exactly one `invoiceKind`, and GOODS is in neither platform list while COMMISSION and
    // DELIVERY are in neither goods filter. So no invoice is ever counted in two returns.
    expect(PLATFORM_INVOICE_KINDS).not.toContain(INVOICE_KIND.GOODS);
    for (const s of [HOUSE_SCOPE, { kind: "seller", sellerId: "s1" } as InvoiceScope]) {
      expect(scopeFilter(s).invoiceKind).toBe(INVOICE_KIND.GOODS);
    }
  });

  it("all is unfiltered — reconciliation only, never a filing", () => {
    expect(scopeFilter({ kind: "all" })).toEqual({});
  });

  it("every existing invoice is GOODS, which is why this refactor moved nothing", () => {
    // The migration defaulted Invoice.invoiceKind to GOODS for all 374 rows, so adding the kind term
    // to the goods scopes is a no-op on today's data by construction. If this constant is ever
    // renamed, every historic row orphans and the shop's return empties — hence the wire-value
    // warning at the constant.
    expect(INVOICE_KIND.GOODS).toBe("GOODS");
  });
});
