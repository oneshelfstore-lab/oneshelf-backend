import { describe, it, expect } from "vitest";
import {
  splitInclusiveDeliveryFee,
  DELIVERY_GST_RATE_PCT,
  DELIVERY_SAC_CODE,
} from "../deliveryTax.js";

/**
 * Runbook step 15. The whole safety property of this step is one equation —
 * `taxable + gst === fee`, exactly, for every fee — because that is what keeps the customer's total
 * from moving. A paisa of drift here is a rupee in a GST return that nobody paid.
 */
describe("splitInclusiveDeliveryFee", () => {
  it("splits the standard ₹30 fee and sums back to it exactly", () => {
    const { taxable, gst } = splitInclusiveDeliveryFee(30);
    expect(taxable).toBe(25.42);
    expect(gst).toBe(4.58);
    expect(taxable + gst).toBe(30);
  });

  it("⚠️ ₹49 is why the GST is SUBTRACTED and not computed from the rate", () => {
    // Apply the rate to the rounded base instead and you get 41.53 + 7.48 = ₹49.01 — a paisa the
    // customer never paid, invented by rounding the two halves independently. This case is the
    // reason the implementation derives one from the other, and it is pinned so that nobody tidies
    // it back into a second multiplication.
    const { taxable, gst } = splitInclusiveDeliveryFee(49);
    expect(taxable).toBe(41.53);
    const naive = Math.round(taxable * (DELIVERY_GST_RATE_PCT / 100) * 100) / 100;
    expect(naive).toBe(7.48);
    expect(+(taxable + naive).toFixed(2)).toBe(49.01); // the bug, demonstrated
    expect(gst).toBe(7.47);                            // what we actually store
    expect(+(taxable + gst).toFixed(2)).toBe(49);      // and it closes
  });

  it("closes for every rupee fee a slab could produce", () => {
    // The property, not three examples. Drift at any fee would be silent money.
    for (let fee = 1; fee <= 500; fee++) {
      const { taxable, gst } = splitInclusiveDeliveryFee(fee);
      expect(+(taxable + gst).toFixed(2)).toBe(fee);
    }
  });

  it("closes for half-rupee fees too", () => {
    for (let paise = 50; paise <= 20000; paise += 50) {
      const fee = paise / 100;
      const { taxable, gst } = splitInclusiveDeliveryFee(fee);
      expect(+(taxable + gst).toFixed(2)).toBe(fee);
    }
  });

  it("a zero or absent fee splits into nothing, never NaN", () => {
    expect(splitInclusiveDeliveryFee(0)).toEqual({ taxable: 0, gst: 0 });
    expect(splitInclusiveDeliveryFee(-5)).toEqual({ taxable: 0, gst: 0 });
  });

  it("a zero rate makes the whole fee the value of supply", () => {
    // Not hypothetical: this is what the branch does if the CA comes back saying delivery rides the
    // goods as a composite supply. It must not divide by 1 + 0 and call the remainder tax.
    expect(splitInclusiveDeliveryFee(30, 0)).toEqual({ taxable: 30, gst: 0 });
  });

  it("the rate and SAC are what the invoice will carry", () => {
    // ⚠️ CA-gated. Changing DELIVERY_GST_RATE_PCT moves no historic order — every split is stored
    // per row — but it changes every order placed after it.
    expect(DELIVERY_GST_RATE_PCT).toBe(18);
    expect(DELIVERY_SAC_CODE).toBe("9968");
  });
});
