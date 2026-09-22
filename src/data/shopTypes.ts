// Shop-type requirement profiles — what a given kind of shop must tell us before it can trade.
//
// WHY THIS IS DATA AND NOT CODE: the alternative is one giant onboarding form with every field a
// pharmacy, a cake shop and a hardware store could ever need, each hidden behind an `if`. Adding a
// shop type then means editing the form, the submit validator and the app. Here it means adding a
// row below. The Android wizard renders whatever this returns; the submit validator derives its
// required-field list from the same profiles, so the screen and the gate can never disagree.
//
// ─── Scope decisions worth not re-litigating ───────────────────────────────────────────────────
//
// ⚠️ SERVICE shops (salon, tailor, electrician, laundry, appliance repair) are deliberately ABSENT.
//    They have no inventory, no delivery and no order in the sense this platform means — they need
//    appointment slots and technician dispatch, which do not exist. A shop type here must route to
//    a catalogue the app can actually render; a service profile would be a form with nowhere to
//    submit. Add them alongside a booking model, not before one.
//
// ⚠️ Per-PRODUCT attributes are not seller-onboarding fields. An electronics shop's IMEI/warranty
//    and a clothing shop's size chart belong on the product, and asking for them here would collect
//    a value that describes nothing. That is why most shop types below carry no extra step at all —
//    what differs between a toy shop and a hardware shop is their catalogue, not their paperwork.
//
// ⚠️ Variable-weight (loose) selling is NOT a separate catalogue model. It is already a variant
//    type inside the standard catalogue (ProductVariant LOOSE/PRODUCE — per-unit price + a minimum
//    increment). `variableWeight` below is only a hint so the product editor can default a fruit
//    seller to kg pricing instead of packs.

export type CatalogueModel = "STANDARD" | "MENU";

export type FieldType = "text" | "number" | "date" | "doc" | "phone" | "email";

export interface RequirementField {
  /** Storage key. With `sellerColumn` set this names a Seller scalar; otherwise it is a key inside
   *  Seller.categoryData (the JSON blob that lets a new shop type ship without a migration). */
  key: string;
  label: string;
  type: FieldType;
  /** Hard-blocks POST /seller/me/onboarding/submit when blank. */
  required: boolean;
  /** Shown under the input. Format hints and — for the fields people hesitate over — why we ask. */
  helper?: string;
  /**
   * Present → this field lives on the Seller row. Absent → it lives in Seller.categoryData.
   *
   * A dotted path ("bankDetails.ifsc") addresses inside an existing JSON column. That is only for
   * `bankDetails`, which predates this design and is where the payout code already looks — new
   * per-trade fields belong in categoryData, not in a new nested blob.
   */
  sellerColumn?: string;
}

/** Read a possibly-dotted `sellerColumn` path off a Seller row. */
export function readSellerPath(seller: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return seller[path];
  const [head, ...rest] = path.split(".");
  let cursor: unknown = seller[head];
  for (const part of rest) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export interface RequirementStep {
  key: string;
  title: string;
  subtitle?: string;
  fields: RequirementField[];
}

export interface ShopTypeProfile {
  key: string;
  label: string;
  department: string;
  vertical: "SHOP" | "FOOD";
  catalogueModel: CatalogueModel;
  /** Default the catalogue editor to per-kg/per-litre pricing (fruit, veg, meat, sweets). */
  variableWeight?: boolean;
  /**
   * Licensed trade. The owner's review queue flags these so a drug licence gets read rather than
   * rubber-stamped, and the app tells the seller to expect a manual check.
   *
   * ⚠️ This flag does NOT create the manual-review requirement — nothing in this system has ever
   * auto-approved a seller (onboardingStatus only reaches APPROVED via ownerOnboardingQueue). It
   * marks WHICH submissions carry real legal weight if waved through.
   */
  regulated?: boolean;
  /** Appended after the core steps. Most shop types add nothing. */
  extraSteps?: RequirementStep[];
}

// ─── Core steps — asked of every shop, defined once ──────────────────────────────────────────────
// Thirty shop types repeating "bank account" is thirty places for it to drift.

export const CORE_STEPS: RequirementStep[] = [
  {
    key: "shop",
    title: "Your shop",
    subtitle: "How customers will find you",
    fields: [
      { key: "name", label: "Shop name", type: "text", required: true, sellerColumn: "name" },
      { key: "phone", label: "Shop phone", type: "phone", required: false, sellerColumn: "phone" },
      {
        key: "shopAddress",
        label: "Shop address",
        type: "text",
        required: true,
        helper: "Where a delivery partner will come to collect orders.",
        sellerColumn: "shopAddress",
      },
      { key: "city", label: "City", type: "text", required: false, sellerColumn: "city" },
      { key: "pincode", label: "Pincode", type: "text", required: false, sellerColumn: "pincode" },
    ],
  },
  {
    key: "tax",
    title: "Tax details",
    subtitle: "Used on the invoices we raise for your sales",
    fields: [
      {
        key: "gstin",
        label: "GSTIN",
        type: "text",
        required: true,
        // ⚠️ Kept hard-required, matching the behaviour this replaced. A shop below the GST
        // threshold genuinely has none, so "GSTIN where applicable" is the more correct rule — but
        // invoices are issued under this number, so relaxing it is an invoicing change (which
        // document a GSTIN-less seller's sales go out under), not an onboarding one. Separate call.
        helper: "15 characters, as printed on your GST certificate.",
        sellerColumn: "gstin",
      },
      { key: "pan", label: "PAN", type: "text", required: true, helper: "10 characters, e.g. ABCDE1234F.", sellerColumn: "pan" },
      { key: "gstinDocUrl", label: "GST certificate", type: "doc", required: false, sellerColumn: "gstinDocUrl" },
      { key: "panDocUrl", label: "PAN card", type: "doc", required: false, sellerColumn: "panDocUrl" },
    ],
  },
  {
    key: "bank",
    title: "Where we pay you",
    subtitle: "Your sales are settled to this account",
    fields: [
      // Not hard-required at submit, matching the behaviour this replaced — a seller can finish
      // onboarding and add payout details before their first settlement. The owner chases it.
      { key: "accountNumber", label: "Bank account number", type: "text", required: false, sellerColumn: "bankDetails.accountNumber" },
      { key: "ifsc", label: "IFSC", type: "text", required: false, helper: "11 characters, e.g. SBIN0001234.", sellerColumn: "bankDetails.ifsc" },
      { key: "upi", label: "UPI ID", type: "text", required: false, helper: "Optional. Often the quickest way to be paid.", sellerColumn: "bankDetails.upi" },
      { key: "bankProofUrl", label: "Cancelled cheque or passbook", type: "doc", required: false, sellerColumn: "bankProofUrl" },
    ],
  },
  {
    key: "grievance",
    title: "Grievance officer",
    subtitle: "The person customers reach about your shop",
    fields: [
      {
        key: "grievanceOfficerName",
        label: "Officer name",
        type: "text",
        required: true,
        // Rule 6, Consumer Protection (E-Commerce) Rules 2020 — this contact is published on your
        // listings. For a one-person shop it is simply the owner.
        helper: "Usually you. This name is shown to customers on your listings.",
        sellerColumn: "grievanceOfficerName",
      },
      { key: "grievanceOfficerPhone", label: "Officer phone", type: "phone", required: true, sellerColumn: "grievanceOfficerPhone" },
      { key: "grievanceOfficerEmail", label: "Officer email", type: "email", required: false, sellerColumn: "grievanceOfficerEmail" },
    ],
  },
];

// ─── Reusable extra steps ────────────────────────────────────────────────────────────────────────

/**
 * Anyone selling food to the public needs an FSSAI licence or registration.
 *
 * This is the single biggest thing profiles fix. FSSAI already existed as a Seller column, asked of
 * EVERY shop type and required of NONE — so a kirana selling packaged food and a hardware shop saw
 * the same optional field. Here it is required exactly where the law requires it, using the columns
 * that already exist: no migration, no new storage.
 */
const FSSAI_STEP: RequirementStep = {
  key: "fssai",
  title: "Food licence",
  subtitle: "Required for any shop selling food",
  fields: [
    {
      key: "fssaiNumber",
      label: "FSSAI number",
      type: "text",
      required: true,
      helper: "14 digits, printed on your FSSAI licence or registration certificate.",
      sellerColumn: "fssaiNumber",
    },
    { key: "fssaiExpiry", label: "Valid until", type: "date", required: false, sellerColumn: "fssaiExpiry" },
    { key: "fssaiDocUrl", label: "FSSAI certificate", type: "doc", required: false, sellerColumn: "fssaiDocUrl" },
  ],
};

/** Restaurant service settings. Every field here is an existing Seller column. */
const KITCHEN_STEP: RequirementStep = {
  key: "kitchen",
  title: "Your kitchen",
  subtitle: "When you cook, and how long you need",
  fields: [
    { key: "cuisines", label: "Cuisines", type: "text", required: false, helper: "Comma separated, e.g. North Indian, Chinese.", sellerColumn: "cuisines" },
    { key: "openTime", label: "Opens at", type: "text", required: false, helper: "24-hour, e.g. 10:00.", sellerColumn: "openTime" },
    { key: "closeTime", label: "Closes at", type: "text", required: false, helper: "24-hour, e.g. 23:00. Past midnight is fine.", sellerColumn: "closeTime" },
    { key: "avgPrepMinutes", label: "Typical prep time (minutes)", type: "number", required: false, sellerColumn: "avgPrepMinutes" },
  ],
};

/** Pharmacy. Stored in categoryData — no migration, and nothing outside this trade carries them. */
const PHARMACY_STEP: RequirementStep = {
  key: "pharmacy",
  title: "Pharmacy licence",
  subtitle: "Verified by our team before you can list medicines",
  fields: [
    { key: "drugLicenseNumber", label: "Drug licence number", type: "text", required: true, helper: "As issued by your State Drugs Control Department." },
    { key: "drugLicenseDocUrl", label: "Drug licence", type: "doc", required: true },
    { key: "drugLicenseExpiry", label: "Valid until", type: "date", required: false },
    { key: "pharmacistName", label: "Registered pharmacist", type: "text", required: true, helper: "The pharmacist on duty at this shop." },
    { key: "pharmacistRegNumber", label: "Pharmacist registration number", type: "text", required: true, helper: "State Pharmacy Council registration." },
  ],
};

const MEDICAL_DEVICE_STEP: RequirementStep = {
  key: "medicalDevice",
  title: "Medical device licence",
  subtitle: "Verified by our team before you can list devices",
  fields: [
    { key: "deviceLicenseNumber", label: "Licence number", type: "text", required: true, helper: "Your CDSCO / State licence for selling medical devices." },
    { key: "deviceLicenseDocUrl", label: "Licence document", type: "doc", required: true },
    { key: "deviceLicenseExpiry", label: "Valid until", type: "date", required: false },
  ],
};

const JEWELLERY_STEP: RequirementStep = {
  key: "jewellery",
  title: "Hallmarking",
  subtitle: "For gold and silver jewellery",
  fields: [
    { key: "bisHuidNumber", label: "BIS registration number", type: "text", required: false, helper: "Required to sell hallmarked gold. Leave blank if you only sell fashion jewellery." },
    { key: "bisCertDocUrl", label: "BIS certificate", type: "doc", required: false },
  ],
};

// ─── The registry ────────────────────────────────────────────────────────────────────────────────
// Ordered by department so the picker can group without a second lookup.

function shop(
  key: string,
  label: string,
  department: string,
  extra: Partial<Omit<ShopTypeProfile, "key" | "label" | "department" | "vertical" | "catalogueModel">> = {},
): ShopTypeProfile {
  return { key, label, department, vertical: "SHOP", catalogueModel: "STANDARD", ...extra };
}

function kitchen(key: string, label: string): ShopTypeProfile {
  return {
    key,
    label,
    department: "Food",
    vertical: "FOOD",
    catalogueModel: "MENU",
    extraSteps: [FSSAI_STEP, KITCHEN_STEP],
  };
}

export const SHOP_TYPES: ShopTypeProfile[] = [
  // Grocery
  shop("GENERAL_STORE", "Kirana / general store", "Grocery", { extraSteps: [FSSAI_STEP] }),
  shop("SUPERMARKET", "Supermarket", "Grocery", { extraSteps: [FSSAI_STEP] }),

  // Fresh
  shop("FRUIT_VEG", "Fruit & vegetable shop", "Fresh", { variableWeight: true, extraSteps: [FSSAI_STEP] }),
  shop("DAIRY", "Dairy shop", "Fresh", { extraSteps: [FSSAI_STEP] }),
  shop("EGGS", "Egg shop", "Fresh", { extraSteps: [FSSAI_STEP] }),
  shop("MEAT_FISH", "Meat, fish & poultry", "Fresh", { variableWeight: true, extraSteps: [FSSAI_STEP] }),

  // Bakery & sweets
  shop("BAKERY", "Bakery", "Bakery & sweets", { extraSteps: [FSSAI_STEP] }),
  shop("CAKE_SHOP", "Cake shop", "Bakery & sweets", { extraSteps: [FSSAI_STEP] }),
  shop("SWEET_SHOP", "Mithai / sweet shop", "Bakery & sweets", { variableWeight: true, extraSteps: [FSSAI_STEP] }),
  shop("CONFECTIONERY", "Confectionery", "Bakery & sweets", { extraSteps: [FSSAI_STEP] }),

  // Food (menu-based — these route to the Food vertical's MenuItem catalogue, not CatalogProduct)
  kitchen("RESTAURANT", "Restaurant"),
  kitchen("FAST_FOOD", "Fast food"),
  kitchen("CAFE", "Café"),
  kitchen("JUICE_BAR", "Juice & beverages"),

  // Beauty
  shop("COSMETICS", "Cosmetics store", "Beauty"),
  shop("PERSONAL_CARE", "Beauty & personal care", "Beauty"),

  // Fashion
  shop("CLOTHING", "Clothing store", "Fashion"),
  shop("FOOTWEAR", "Footwear store", "Fashion"),
  shop("ACCESSORIES", "Fashion accessories", "Fashion"),
  shop("BAGS", "Bags & luggage", "Fashion"),

  // Books & stationery
  shop("STATIONERY", "Stationery shop", "Books & stationery"),
  shop("BOOKS", "Book store", "Books & stationery"),

  // Toys & gifts
  shop("TOYS", "Toy store", "Toys & gifts"),
  shop("GIFTS", "Gift shop", "Toys & gifts"),
  shop("PARTY", "Party supplies", "Toys & gifts"),

  // Electronics — no extra paperwork; warranty/IMEI are per-product, not per-seller.
  shop("MOBILE", "Mobile shop", "Electronics"),
  shop("COMPUTER", "Computer store", "Electronics"),
  shop("ELECTRONICS", "Electronics store", "Electronics"),

  // Health
  shop("PHARMACY", "Pharmacy", "Health", { regulated: true, extraSteps: [PHARMACY_STEP] }),
  shop("MEDICAL_DEVICE", "Medical device store", "Health", { regulated: true, extraSteps: [MEDICAL_DEVICE_STEP] }),
  shop("OPTICAL", "Optical shop", "Health"),
  shop("MEDICAL_SUPPLIES", "Medical supplies", "Health"),

  // Baby & kids
  shop("BABY_STORE", "Baby store", "Baby & kids"),
  shop("BABY_FOOD", "Baby food", "Baby & kids", { extraSteps: [FSSAI_STEP] }),
  shop("KIDS", "Kids store", "Baby & kids"),

  // Home
  shop("HOME_KITCHEN", "Home & kitchen", "Home"),
  shop("HOME_DECOR", "Home decor", "Home"),
  shop("FURNITURE", "Furniture store", "Home"),
  shop("HOUSEHOLD", "Plastic & household", "Home"),

  // Hardware
  shop("HARDWARE", "Hardware store", "Hardware"),
  shop("ELECTRICAL", "Electrical store", "Hardware"),
  shop("PLUMBING", "Plumbing store", "Hardware"),
  shop("PAINT", "Paint store", "Hardware"),

  // Sports, pet, garden
  shop("SPORTS", "Sports store", "Sports"),
  shop("FITNESS", "Gym & fitness", "Sports"),
  shop("PET", "Pet store", "Pet"),
  shop("PET_FOOD", "Pet food", "Pet", { extraSteps: [FSSAI_STEP] }),
  shop("NURSERY", "Nursery & plants", "Garden"),
  shop("GARDENING", "Gardening supplies", "Garden"),

  // Other
  shop("JEWELLERY", "Jewellery store", "Jewellery", { extraSteps: [JEWELLERY_STEP] }),
  shop("AUTO_PARTS", "Auto parts", "Automotive"),
];

const BY_KEY = new Map(SHOP_TYPES.map((s) => [s.key, s]));

/**
 * The profile for a seller's stored shopType.
 *
 * ⚠️ Falls back on `vertical` when shopType is null, which is every seller that existed before this
 * column did. They keep working with no backfill: a SHOP becomes a general store, a FOOD seller a
 * restaurant — the two profiles their data was already collected under.
 */
export function profileFor(shopType: string | null | undefined, vertical: string): ShopTypeProfile {
  const direct = shopType ? BY_KEY.get(shopType) : undefined;
  if (direct) return direct;
  return BY_KEY.get(vertical === "FOOD" ? "RESTAURANT" : "GENERAL_STORE")!;
}

export function isKnownShopType(key: string): boolean {
  return BY_KEY.has(key);
}

/** Core steps plus whatever this trade adds. The wizard renders these in order. */
export function stepsFor(profile: ShopTypeProfile): RequirementStep[] {
  return [...CORE_STEPS, ...(profile.extraSteps ?? [])];
}

/** Every field of a profile, flattened. */
export function fieldsFor(profile: ShopTypeProfile): RequirementField[] {
  return stepsFor(profile).flatMap((s) => s.fields);
}

/** Field keys stored in Seller.categoryData rather than on the Seller row. */
export function categoryFieldKeys(profile: ShopTypeProfile): string[] {
  return fieldsFor(profile).filter((f) => !f.sellerColumn).map((f) => f.key);
}

/** categoryData keys holding a Storage object path — these get signed on read. */
export function categoryDocKeys(profile: ShopTypeProfile): string[] {
  return fieldsFor(profile).filter((f) => !f.sellerColumn && f.type === "doc").map((f) => f.key);
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * Fold one step's worth of category fields into what the seller already had.
 *
 * ⚠️ MERGE, not replace. The wizard saves as you move between steps, so a request carrying step 5's
 * two fields must not wipe step 4's. Omitted key = untouched; explicit blank = cleared (dropped, so
 * the blob never accumulates empty strings). This mirrors how the surrounding PUT already treats
 * every other field.
 *
 * Unknown keys are REPORTED rather than silently stored — a typo'd key would otherwise sit in the
 * blob forever looking like data, and a required field would read as blank with its value sitting
 * one character away.
 */
export function mergeCategoryData(
  current: unknown,
  incoming: Record<string, unknown> | null | undefined,
  profile: ShopTypeProfile,
): { merged: Record<string, unknown> | null; unknownKeys: string[] } {
  const base: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};

  if (incoming == null) return { merged: Object.keys(base).length ? base : null, unknownKeys: [] };

  const allowed = new Set(categoryFieldKeys(profile));
  const unknownKeys: string[] = [];

  for (const [key, value] of Object.entries(incoming)) {
    if (!allowed.has(key)) {
      unknownKeys.push(key);
      continue;
    }
    if (isBlank(value)) delete base[key];
    else base[key] = value;
  }

  return { merged: Object.keys(base).length ? base : null, unknownKeys };
}

/**
 * Labels of every required field still blank — what POST /onboarding/submit refuses on, and what
 * the wizard's progress bar counts against.
 *
 * Pure so it can be tested without a database, and shared by the submit gate and the progress
 * endpoint so a seller can never see "100% complete" on a form the server will reject.
 */
export function missingRequiredFields(
  profile: ShopTypeProfile,
  seller: Record<string, unknown>,
  categoryData: Record<string, unknown> | null | undefined,
): string[] {
  return fieldsFor(profile)
    .filter((f) => f.required)
    .filter((f) =>
      isBlank(f.sellerColumn ? readSellerPath(seller, f.sellerColumn) : (categoryData ?? {})[f.key]),
    )
    .map((f) => f.label);
}

/** 0–100, for the wizard's progress bar. Counts required fields only — optional documents must not
 *  make a seller who has finished look stuck at 80%. */
export function completionPct(
  profile: ShopTypeProfile,
  seller: Record<string, unknown>,
  categoryData: Record<string, unknown> | null | undefined,
): number {
  const required = fieldsFor(profile).filter((f) => f.required);
  if (required.length === 0) return 100;
  const missing = missingRequiredFields(profile, seller, categoryData).length;
  return Math.round(((required.length - missing) / required.length) * 100);
}
