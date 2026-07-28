import { describe, it, expect } from "vitest";
import { isDeliveryFeeCompulsory } from "../cartPricing.js";

/**
 * The compulsory-delivery floor: below it, neither a FREE_DELIVERY coupon nor a member tier perk may
 * waive the fee. Getting the boundary wrong is silent money — one rupee either way decides whether a
 * small basket ships free.
 */
const at = (deliveryEligibleSubtotal: number, compulsoryDeliveryUpto = 99, isPickup = false) =>
  isDeliveryFeeCompulsory({ isPickup, compulsoryDeliveryUpto, deliveryEligibleSubtotal });

describe("isDeliveryFeeCompulsory", () => {
  it("charges at or below the floor — the boundary is inclusive", () => {
    expect(at(40)).toBe(true);
    expect(at(98.99)).toBe(true);
    expect(at(99)).toBe(true); // "equal to or below ₹99"
  });

  it("leaves anything above the floor to the normal free-delivery rules", () => {
    expect(at(99.01)).toBe(false);
    expect(at(100)).toBe(false);
    expect(at(600)).toBe(false);
  });

  it("is off entirely when the store hasn't set a floor", () => {
    expect(at(40, 0)).toBe(false);
    expect(at(0, 0)).toBe(false);
  });

  it("never applies to pickup — there's no delivery to charge for", () => {
    expect(at(40, 99, true)).toBe(false);
    expect(at(0, 99, true)).toBe(false);
  });

  it("treats an empty cart as under the floor (it is), not as a special case", () => {
    expect(at(0)).toBe(true);
  });
});
