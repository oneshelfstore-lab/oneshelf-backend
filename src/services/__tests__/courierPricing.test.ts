import { describe, it, expect } from "vitest";
import {
  checkCourierEligibility,
  computeCourierPrice,
  parseOr,
  courierSlabsSchema,
  DEFAULT_COURIER_SLABS,
  DEFAULT_WEIGHT_SURCHARGE,
  type CourierPricingConfig,
} from "../courierPricing.js";

const cfg: CourierPricingConfig = {
  maxKm: 10,
  slabs: DEFAULT_COURIER_SLABS,
  weightSurcharge: DEFAULT_WEIGHT_SURCHARGE,
  expressFee: 17,
  platformFee: 3,
  storeLat: 29.37,
  storeLng: 78.13,
  pickupRadiusKm: 15,
};

// ~0.009° lat ≈ 1 km
const at = (kmNorth: number) => ({ lat: 29.37 + kmNorth * 0.009, lng: 78.13 });

describe("computeCourierPrice", () => {
  it("matches the mockup: 6.8 km standard ₹49 + ₹3 = ₹52, express ₹69", () => {
    expect(computeCourierPrice(6.8, "UPTO_1", "STANDARD", cfg)).toEqual({ deliveryFee: 49, platformFee: 3, total: 52 });
    expect(computeCourierPrice(6.8, "UPTO_1", "EXPRESS", cfg).total).toBe(69);
  });

  it("slab edges are inclusive (2.0 km is the first slab, 2.01 the second)", () => {
    expect(computeCourierPrice(2, "UPTO_1", "STANDARD", cfg).deliveryFee).toBe(30);
    expect(computeCourierPrice(2.01, "UPTO_1", "STANDARD", cfg).deliveryFee).toBe(40);
  });

  it("adds the weight surcharge", () => {
    expect(computeCourierPrice(1, "KG_5_10", "STANDARD", cfg).deliveryFee).toBe(50);
  });

  it("beyond the last slab the top slab is a ceiling, never a crash", () => {
    expect(computeCourierPrice(12, "UPTO_1", "STANDARD", cfg).deliveryFee).toBe(59);
  });
});

describe("checkCourierEligibility", () => {
  it("accepts a 6 km drop", () => {
    const r = checkCourierEligibility(at(0), at(6), cfg);
    expect(r.eligible).toBe(true);
  });

  it("refuses beyond maxKm and says why", () => {
    const r = checkCourierEligibility(at(0), at(11), cfg);
    expect(r).toMatchObject({ eligible: false, reason: "DROP_TOO_FAR" });
  });

  it("10.0 km exactly is allowed", () => {
    expect(checkCourierEligibility(at(0), at(9.9), cfg).eligible).toBe(true);
  });

  it("refuses a pickup outside the store service area", () => {
    const far = { lat: 30.5, lng: 78.13 };
    expect(checkCourierEligibility(far, { lat: 30.51, lng: 78.13 }, cfg)).toMatchObject({
      eligible: false,
      reason: "PICKUP_OUT_OF_AREA",
    });
  });

  it("no service-area check when the store location or radius is unset", () => {
    const far = { lat: 30.5, lng: 78.13 };
    const open = { ...cfg, pickupRadiusKm: null };
    expect(checkCourierEligibility(far, { lat: 30.51, lng: 78.13 }, open).eligible).toBe(true);
  });

  it("refuses pickup == drop", () => {
    expect(checkCourierEligibility(at(0), at(0), cfg)).toMatchObject({ eligible: false, reason: "SAME_LOCATION" });
  });
});

describe("parseOr", () => {
  it("falls back on invalid stored config instead of throwing", () => {
    const bad = [{ uptoKm: 5, charge: 10 }, { uptoKm: 3, charge: 20 }]; // not ascending
    expect(parseOr(courierSlabsSchema, bad, DEFAULT_COURIER_SLABS, "courierSlabs")).toBe(DEFAULT_COURIER_SLABS);
    expect(parseOr(courierSlabsSchema, null, DEFAULT_COURIER_SLABS, "courierSlabs")).toBe(DEFAULT_COURIER_SLABS);
  });
});
