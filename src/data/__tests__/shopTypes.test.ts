import { describe, it, expect } from "vitest";
import {
  SHOP_TYPES,
  profileFor,
  isKnownShopType,
  stepsFor,
  fieldsFor,
  categoryDocKeys,
  mergeCategoryData,
  missingRequiredFields,
  completionPct,
  readSellerPath,
  effectiveProfile,
  isAlsoSellKey,
  DEPARTMENT_REP,
  DEPARTMENT_EXTRAS,
  categoriesFromLead,
} from "../shopTypes.js";

/**
 * Every failure mode here is silent on screen.
 *
 * A required field dropped from a profile doesn't break the wizard — it renders a shorter form and
 * lets a shop trade without the paperwork. A merge that replaces instead of folding doesn't error —
 * it quietly wipes the step the seller filled in a minute ago. A fallback that resolves to the
 * wrong profile doesn't 500 — it asks a pharmacy for a grocery's documents. None of these surface
 * as a crash, which is why they are pinned here.
 */

const GENERAL = profileFor("GENERAL_STORE", "SHOP");
const PHARMACY = profileFor("PHARMACY", "SHOP");
const RESTAURANT = profileFor("RESTAURANT", "FOOD");
const HARDWARE = profileFor("HARDWARE", "SHOP");

/** A seller row with every core requirement satisfied. */
const completeCore = {
  name: "Raghav General Store",
  shopAddress: "12 Main Bazaar",
  gstin: "09ABCDE1234F2ZX",
  pan: "ABCDE1234F",
  grievanceOfficerName: "Raghav",
  grievanceOfficerPhone: "9876543210",
  fssaiNumber: "12345678901234",
};

describe("the registry itself", () => {
  it("has no duplicate keys", () => {
    const keys = SHOP_TYPES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Service trades were deliberately excluded: they need appointment slots and technician dispatch,
  // neither of which exists. A profile here must route to a catalogue the app can actually render,
  // so if one of these ever appears it means someone added a form with nowhere to submit.
  it("carries no service trades", () => {
    const keys = SHOP_TYPES.map((s) => s.key);
    for (const banned of ["SALON", "TAILOR", "ELECTRICIAN", "PLUMBER", "LAUNDRY", "APPLIANCE_REPAIR"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("routes food trades to the menu catalogue and everything else to the standard one", () => {
    expect(RESTAURANT.catalogueModel).toBe("MENU");
    expect(RESTAURANT.vertical).toBe("FOOD");
    expect(GENERAL.catalogueModel).toBe("STANDARD");
    expect(HARDWARE.catalogueModel).toBe("STANDARD");
  });

  it("flags only the licensed trades as regulated", () => {
    expect(PHARMACY.regulated).toBe(true);
    expect(profileFor("MEDICAL_DEVICE", "SHOP").regulated).toBe(true);
    expect(GENERAL.regulated).toBeUndefined();
  });
});

describe("profileFor", () => {
  // The backward-compat path: every seller that existed before shopType did has null, and must
  // still resolve to the profile their data was already collected under — no backfill.
  it("falls back on vertical when the shop type is missing", () => {
    expect(profileFor(null, "SHOP").key).toBe("GENERAL_STORE");
    expect(profileFor(null, "FOOD").key).toBe("RESTAURANT");
    expect(profileFor(undefined, "SHOP").key).toBe("GENERAL_STORE");
  });

  it("falls back rather than throwing on an unrecognised type", () => {
    expect(profileFor("NOT_A_REAL_SHOP", "SHOP").key).toBe("GENERAL_STORE");
    expect(isKnownShopType("NOT_A_REAL_SHOP")).toBe(false);
    expect(isKnownShopType("PHARMACY")).toBe(true);
  });
});

describe("category-specific fields", () => {
  it("asks every shop for the core four steps", () => {
    const keys = stepsFor(HARDWARE).map((s) => s.key);
    // Ordered by stage (business → verification → settlement), so payout details come last.
    expect(keys).toEqual(["shop", "tax", "grievance", "bank"]);
  });

  it("never moves backwards through the progress stages", () => {
    const order = ["business", "verification", "settlement"];
    for (const p of [GENERAL, PHARMACY, RESTAURANT, HARDWARE]) {
      const idx = stepsFor(p).map((s) => order.indexOf(s.stage!));
      expect(idx.every((v) => v >= 0)).toBe(true);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
  });

  // The headline fix: FSSAI already existed as a column, asked of everyone and required of no one.
  it("requires FSSAI of food trades and never asks a hardware shop for it", () => {
    expect(fieldsFor(GENERAL).some((f) => f.key === "fssaiNumber" && f.required)).toBe(true);
    expect(fieldsFor(RESTAURANT).some((f) => f.key === "fssaiNumber" && f.required)).toBe(true);
    expect(fieldsFor(HARDWARE).some((f) => f.key === "fssaiNumber")).toBe(false);
  });

  it("asks a pharmacy for its licence and nobody else", () => {
    expect(fieldsFor(PHARMACY).some((f) => f.key === "drugLicenseNumber" && f.required)).toBe(true);
    expect(fieldsFor(GENERAL).some((f) => f.key === "drugLicenseNumber")).toBe(false);
  });

  // Docs inside categoryData are signed on read exactly like the fixed KYC columns. Miss one and a
  // drug licence is served as a raw Storage path that resolves to nothing — or worse, is stored as
  // a permanent public URL because nobody noticed it wasn't going through signing.
  it("reports the category doc keys that need signing", () => {
    expect(categoryDocKeys(PHARMACY)).toContain("drugLicenseDocUrl");
    expect(categoryDocKeys(PHARMACY)).not.toContain("drugLicenseNumber");
    expect(categoryDocKeys(HARDWARE)).toEqual([]);
  });

  it("keeps category fields out of the seller row and core fields on it", () => {
    const drugLicence = fieldsFor(PHARMACY).find((f) => f.key === "drugLicenseNumber");
    const gstin = fieldsFor(PHARMACY).find((f) => f.key === "gstin");
    expect(drugLicence?.sellerColumn).toBeUndefined();
    expect(gstin?.sellerColumn).toBe("gstin");
  });
});

describe("departments (what the seller picks)", () => {
  it("gives every department a representative that exists and belongs to it", () => {
    for (const dept of new Set(SHOP_TYPES.map((s) => s.department))) {
      const rep = SHOP_TYPES.find((s) => s.key === DEPARTMENT_REP[dept]);
      expect(rep, dept).toBeDefined();
      expect(rep!.department).toBe(dept);
    }
  });

  // Picking "Health" must not, by itself, demand a drug licence (an optician has none) — the licensed
  // lines are explicit extras. If a regulated rep slips in, every optical shop is blocked at submit.
  it("never lets a department imply a regulated trade", () => {
    for (const rep of Object.values(DEPARTMENT_REP)) {
      expect(SHOP_TYPES.find((s) => s.key === rep)!.regulated).toBeFalsy();
    }
    expect(DEPARTMENT_EXTRAS.Health!.map((e) => e.key)).toEqual(["PHARMACY", "MEDICAL_DEVICE"]);
  });

  it("turns a lead-form category string into primary + also-sell", () => {
    expect(categoriesFromLead("Grocery,Fresh,Electronics")).toEqual({
      shopType: "GENERAL_STORE",
      alsoSell: ["FRUIT_VEG", "ELECTRONICS"],
    });
    // Case-insensitive, tolerates old free text and gaps, dedupes.
    expect(categoriesFromLead(" fresh , kirana ,, Fresh")).toEqual({ shopType: "FRUIT_VEG", alsoSell: [] });
    expect(categoriesFromLead("kirana store")).toBeNull();
    expect(categoriesFromLead(null)).toBeNull();
  });

  it("lets a restaurant stand alone", () => {
    expect(categoriesFromLead("Grocery,Food")).toEqual({ shopType: "RESTAURANT", alsoSell: [] });
  });

  it("locks the phone and offers an optional map pin on the shop step", () => {
    const shop = stepsFor(GENERAL).find((s) => s.key === "shop")!;
    expect(shop.fields.find((f) => f.key === "phone")?.locked).toBe(true);
    const pin = shop.fields.find((f) => f.type === "location")!;
    expect(pin.required).toBe(false);
    expect(shop.fields.some((f) => f.key === "landmark")).toBe(true);
  });
});

describe("fresh follow-up questions (5c)", () => {
  const FRESH = profileFor("FRUIT_VEG", "SHOP");

  // They are guidance for the product editor, not paperwork — one unanswered must never block submit.
  it("asks fresh trades the follow-ups, all optional", () => {
    const fields = stepsFor(FRESH).find((s) => s.key === "fresh")!.fields;
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((f) => f.type === "choice" && !f.required && (f.options?.length ?? 0) >= 2)).toBe(true);
    expect(missingRequiredFields(FRESH, completeCore, null)).toEqual([]);
  });

  it("does not ask a non-fresh trade, but does when fresh is also sold", () => {
    expect(stepsFor(HARDWARE).some((s) => s.key === "fresh")).toBe(false);
    expect(stepsFor(effectiveProfile("HARDWARE", "SHOP", ["DAIRY"])).some((s) => s.key === "fresh")).toBe(true);
  });

  it("stores a valid choice and rejects one outside its options", () => {
    const ok = mergeCategoryData(null, { freshStockChanges: "Daily" }, FRESH);
    expect(ok.merged).toEqual({ freshStockChanges: "Daily" });
    const bad = mergeCategoryData(null, { freshStockChanges: "Hourly" }, FRESH);
    expect(bad.unknownKeys).toEqual(["freshStockChanges"]);
    expect(bad.merged).toBeNull();
    // Blank still clears, as for every other field.
    expect(mergeCategoryData({ freshStockChanges: "Daily" }, { freshStockChanges: "" }, FRESH).merged).toBeNull();
  });
});

describe("effectiveProfile", () => {
  // The decision: a grocery that also sells medicines owes the drug licence too. If this silently
  // returned the primary profile, the seller would be waved through without it.
  it("requires a secondary regulated trade's licence", () => {
    const p = effectiveProfile("GENERAL_STORE", "SHOP", ["PHARMACY"]);
    expect(fieldsFor(p).some((f) => f.key === "drugLicenseNumber" && f.required)).toBe(true);
    expect(p.regulated).toBe(true);
    expect(missingRequiredFields(p, completeCore, null)).toContain("Drug licence number");
  });

  it("does not duplicate a step both trades share", () => {
    const keys = stepsFor(effectiveProfile("GENERAL_STORE", "SHOP", ["DAIRY", "BAKERY"])).map((s) => s.key);
    expect(keys.filter((k) => k === "fssai")).toHaveLength(1);
  });

  it("is a no-op with nothing extra, and ignores unknown, self and kitchen keys", () => {
    expect(effectiveProfile("HARDWARE", "SHOP", []).extraSteps).toEqual([]);
    const ignored = effectiveProfile("HARDWARE", "SHOP", ["NOPE", "HARDWARE", "RESTAURANT"]);
    expect(ignored.extraSteps).toEqual([]);
    expect(ignored.regulated).toBe(false);
  });

  it("only allows shop trades in the also-sell list", () => {
    expect(isAlsoSellKey("PHARMACY")).toBe(true);
    expect(isAlsoSellKey("RESTAURANT")).toBe(false);
    expect(isAlsoSellKey("NOPE")).toBe(false);
  });
});

describe("readSellerPath", () => {
  // bankDetails predates this design and is a JSON column the payout code already reads, so those
  // three fields are addressed by path rather than moved. Everything else is a plain column.
  it("reads a plain column and a dotted path into bankDetails", () => {
    const seller = { gstin: "09ABCDE1234F2ZX", bankDetails: { ifsc: "SBIN0001234" } };
    expect(readSellerPath(seller, "gstin")).toBe("09ABCDE1234F2ZX");
    expect(readSellerPath(seller, "bankDetails.ifsc")).toBe("SBIN0001234");
  });

  it("returns undefined rather than throwing when the blob is absent", () => {
    expect(readSellerPath({}, "bankDetails.ifsc")).toBeUndefined();
    expect(readSellerPath({ bankDetails: null }, "bankDetails.ifsc")).toBeUndefined();
  });

  it("wires the bank step's fields to bankDetails, not to columns of their own", () => {
    const bank = stepsFor(GENERAL).find((s) => s.key === "bank")!;
    expect(bank.fields.find((f) => f.key === "ifsc")?.sellerColumn).toBe("bankDetails.ifsc");
    // Payout details stay optional at submit, as they were before profiles existed.
    expect(bank.fields.every((f) => !f.required)).toBe(true);
  });
});

describe("missingRequiredFields", () => {
  it("passes a fully filled general store", () => {
    expect(missingRequiredFields(GENERAL, completeCore, null)).toEqual([]);
  });

  it("names what is blank, not just that something is", () => {
    const missing = missingRequiredFields(GENERAL, { ...completeCore, pan: "", gstin: null }, null);
    expect(missing).toContain("PAN");
    expect(missing).toContain("GSTIN");
    expect(missing).not.toContain("Shop address");
  });

  it("treats whitespace as blank", () => {
    expect(missingRequiredFields(GENERAL, { ...completeCore, pan: "   " }, null)).toContain("PAN");
  });

  // A pharmacy with perfect core paperwork is still not complete — that is the whole point of
  // per-category requirements.
  it("blocks a pharmacy whose core fields are done but whose licence is not", () => {
    const missing = missingRequiredFields(PHARMACY, completeCore, null);
    expect(missing).toContain("Drug licence number");
    expect(missing).toContain("Registered pharmacist");
    expect(missing).not.toContain("PAN");
  });

  it("clears once the category fields arrive", () => {
    const categoryData = {
      drugLicenseNumber: "UP-1234",
      drugLicenseDocUrl: "seller_kyc/abc/licence.jpg",
      pharmacistName: "S. Verma",
      pharmacistRegNumber: "UPSPC-9912",
    };
    expect(missingRequiredFields(PHARMACY, completeCore, categoryData)).toEqual([]);
  });
});

describe("completionPct", () => {
  it("is 100 only when nothing required is blank", () => {
    expect(completionPct(GENERAL, completeCore, null)).toBe(100);
  });

  it("never reports 100 for a pharmacy missing its licence", () => {
    expect(completionPct(PHARMACY, completeCore, null)).toBeLessThan(100);
  });

  it("starts at 0 for an untouched application", () => {
    expect(completionPct(GENERAL, {}, null)).toBe(0);
  });
});

describe("mergeCategoryData", () => {
  it("folds a new step into what is already there", () => {
    const { merged } = mergeCategoryData({ drugLicenseNumber: "UP-1234" }, { pharmacistName: "S. Verma" }, PHARMACY);
    expect(merged).toEqual({ drugLicenseNumber: "UP-1234", pharmacistName: "S. Verma" });
  });

  it("overwrites a value the seller corrected", () => {
    const { merged } = mergeCategoryData({ drugLicenseNumber: "OLD" }, { drugLicenseNumber: "NEW" }, PHARMACY);
    expect(merged).toEqual({ drugLicenseNumber: "NEW" });
  });

  it("drops a field the seller cleared, and keeps the rest", () => {
    const { merged } = mergeCategoryData(
      { drugLicenseNumber: "UP-1234", pharmacistName: "S. Verma" },
      { pharmacistName: "" },
      PHARMACY,
    );
    expect(merged).toEqual({ drugLicenseNumber: "UP-1234" });
  });

  it("leaves everything untouched when the request carries no category data at all", () => {
    const { merged } = mergeCategoryData({ drugLicenseNumber: "UP-1234" }, undefined, PHARMACY);
    expect(merged).toEqual({ drugLicenseNumber: "UP-1234" });
  });

  // A typo'd key would otherwise sit in the blob looking like data while the required field it was
  // meant to be reads as blank.
  it("reports keys that aren't part of this trade instead of storing them", () => {
    const { merged, unknownKeys } = mergeCategoryData({}, { drugLicenseNumber: "UP-1", nonsense: "x" }, PHARMACY);
    expect(unknownKeys).toEqual(["nonsense"]);
    expect(merged).toEqual({ drugLicenseNumber: "UP-1" });
  });

  it("refuses a pharmacy field sent by a general store", () => {
    const { unknownKeys } = mergeCategoryData({}, { drugLicenseNumber: "UP-1" }, GENERAL);
    expect(unknownKeys).toEqual(["drugLicenseNumber"]);
  });

  it("collapses an emptied blob to null rather than storing {}", () => {
    const { merged } = mergeCategoryData({ pharmacistName: "S. Verma" }, { pharmacistName: null }, PHARMACY);
    expect(merged).toBeNull();
  });

  it("survives a corrupt stored value", () => {
    expect(mergeCategoryData("not an object", { pharmacistName: "S. Verma" }, PHARMACY).merged).toEqual({
      pharmacistName: "S. Verma",
    });
    expect(mergeCategoryData(null, null, PHARMACY).merged).toBeNull();
  });
});
