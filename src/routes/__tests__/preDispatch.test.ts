import { describe, it, expect } from "vitest";
import { isPreDispatchEligible } from "../delivery.js";

/**
 * Pre-dispatch puts a food order in the rider pool WHILE it is still cooking, so the rider's trip to
 * the restaurant overlaps prep instead of running in series after it.
 *
 * Both failure directions are silent and expensive:
 *   - too LOOSE  → a rider is sent out for an order the restaurant hasn't accepted (and may reject),
 *     or for an online order whose payment never confirmed;
 *   - too STRICT → nothing changes and the rider still starts riding only once the food is already
 *     sitting on the pass, which is the behaviour this exists to fix.
 *
 * `/picked-up` still refuses anything that is not PACKED, so an over-eager claim only costs the rider
 * some waiting — it can never tell the customer their food is on the way when it is not.
 */

const READY_SOON = () => new Date(Date.now() + 3 * 60_000); // within the 10-min lead window
const READY_LATER = () => new Date(Date.now() + 45 * 60_000); // a long biryani, well outside it

const order = (o: Record<string, unknown> = {}) => ({
  source: "FOOD",
  status: "PLACED",
  fulfillmentType: "DELIVERY",
  paymentMethod: "COD",
  paymentStatus: "PENDING",
  estimatedReadyAt: READY_SOON(),
  subOrders: [{ status: "ACCEPTED" }],
  ...o,
});

describe("isPreDispatchEligible", () => {
  it("pools a food order the restaurant is actively cooking and is nearly ready", () => {
    expect(isPreDispatchEligible(order())).toBe(true);
  });

  it("also pools it from CONFIRMED", () => {
    expect(isPreDispatchEligible(order({ status: "CONFIRMED" }))).toBe(true);
  });

  it("does NOT pool before the restaurant has accepted", () => {
    // The single most important guard: a PLACED sub-order may still be rejected, and dispatching a
    // rider for an order that then vanishes is worse than dispatching late.
    expect(isPreDispatchEligible(order({ subOrders: [{ status: "PLACED" }] }))).toBe(false);
  });

  it("does NOT pool with no sub-orders at all", () => {
    expect(isPreDispatchEligible(order({ subOrders: [] }))).toBe(false);
    expect(isPreDispatchEligible(order({ subOrders: undefined }))).toBe(false);
  });

  it("does NOT pool while the food is still far from ready", () => {
    expect(isPreDispatchEligible(order({ estimatedReadyAt: READY_LATER() }))).toBe(false);
  });

  it("does NOT pool an order with no ready estimate", () => {
    expect(isPreDispatchEligible(order({ estimatedReadyAt: null }))).toBe(false);
    expect(isPreDispatchEligible(order({ estimatedReadyAt: undefined }))).toBe(false);
  });

  it("does NOT pool an unpaid online order", () => {
    // Mirrors maybeAdvanceParentOrder: never ship an online order whose payment hasn't confirmed.
    expect(isPreDispatchEligible(order({ paymentMethod: "ONLINE", paymentStatus: "PENDING" }))).toBe(false);
    expect(isPreDispatchEligible(order({ paymentMethod: "UPI", paymentStatus: "PENDING" }))).toBe(false);
  });

  it("DOES pool a paid online order", () => {
    expect(isPreDispatchEligible(order({ paymentMethod: "ONLINE", paymentStatus: "PAID" }))).toBe(true);
  });

  it("DOES pool a COD order that is still payment-PENDING — cash is collected at the door", () => {
    expect(isPreDispatchEligible(order({ paymentMethod: "COD", paymentStatus: "PENDING" }))).toBe(true);
  });

  it("does NOT pool a grocery order", () => {
    // Grocery has no prep step to overlap; its existing PACKED-only pool branch is correct.
    expect(isPreDispatchEligible(order({ source: "APP" }))).toBe(false);
    expect(isPreDispatchEligible(order({ source: "BULK_QUOTE" }))).toBe(false);
    expect(isPreDispatchEligible(order({ source: null }))).toBe(false);
  });

  it("does NOT pool a PICKUP order — there is no rider leg to overlap", () => {
    expect(isPreDispatchEligible(order({ fulfillmentType: "PICKUP" }))).toBe(false);
  });

  it("does NOT re-pool an order that already moved past cooking", () => {
    // PACKED is handled by the ordinary pool branch; anything later is already someone's job.
    for (const status of ["PACKED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"]) {
      expect(isPreDispatchEligible(order({ status }))).toBe(false);
    }
  });
});
