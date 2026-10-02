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

// "choice" = pick one of `options` (rendered as chips; the stored value is the option string).
// "location" = a map pin; stored as Seller.lat/lng, rendered as a picker rather than a text box.
export type FieldType = "text" | "number" | "date" | "doc" | "phone" | "email" | "choice" | "location";

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
  /** Required when `type` is "choice"; the allowed answers, in display order. */
  options?: string[];
  /**
   * Read-only in the wizard once it has a value. For identity-like fields that were filled in
   * before the seller got here (the login phone) — re-typing them is how they drift apart. A field
   * that is still blank stays editable, or an owner-added seller with no phone could never set one.
   */
  locked?: boolean;
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

/** Which stage of the wizard's progress strip a step belongs to. The strip is
 *  Business · Categories · Verification · Settlement · Review; "Categories" and "Review" are the
 *  app's own picker/summary screens, so only these three come from the registry. */
export type StepStage = "business" | "verification" | "settlement";

const STAGE_ORDER: StepStage[] = ["business", "verification", "settlement"];

export interface RequirementStep {
  key: string;
  title: string;
  subtitle?: string;
  /** Defaults to "verification" — the stage most paperwork belongs to. */
  stage?: StepStage;
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
    stage: "business",
    fields: [
      { key: "name", label: "Shop name", type: "text", required: true, sellerColumn: "name" },
      {
        key: "phone",
        label: "Phone number",
        type: "phone",
        required: false,
        helper: "This is your login number, so it can't be changed here.",
        sellerColumn: "phone",
        locked: true,
      },
      {
        key: "shopAddress",
        label: "Shop address",
        type: "text",
        required: true,
        helper: "Building, street and area — where a delivery partner will come to collect orders.",
        sellerColumn: "shopAddress",
      },
      // Lives in categoryData (no sellerColumn): a free-text hint for riders, not a legal field.
      { key: "landmark", label: "Nearby landmark", type: "text", required: false, helper: "e.g. opposite the bus stand" },
      { key: "city", label: "City", type: "text", required: false, sellerColumn: "city" },
      { key: "pincode", label: "Pincode", type: "text", required: false, sellerColumn: "pincode" },
      // Optional on purpose: the owner can drop the exact pin later (ownerSellers PATCH), and an
      // applicant indoors with no GPS must not be stuck on this step.
      {
        key: "shopLocation",
        label: "Exact location on map",
        type: "location",
        required: false,
        helper: "So riders and customers find the right door.",
        sellerColumn: "lat",
      },
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
    stage: "settlement",
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
    // Worded for a shopkeeper, not a statute. The field KEYS stay grievanceOfficer* — Rule 6
    // (Consumer Protection (E-Commerce) Rules 2020) still requires this contact on every listing, and
    // the PDP reads those columns. Only the labels changed. For a one-person shop it is simply the
    // owner; the app offers a "same as me" switch for that.
    title: "Who handles complaints?",
    subtitle: "Customers contact this person if something goes wrong with an order",
    fields: [
      {
        key: "grievanceOfficerName",
        label: "Contact name",
        type: "text",
        required: true,
        helper: "Usually you. This name is shown to customers on your listings.",
        sellerColumn: "grievanceOfficerName",
      },
      { key: "grievanceOfficerPhone", label: "Contact phone", type: "phone", required: true, sellerColumn: "grievanceOfficerPhone" },
      { key: "grievanceOfficerEmail", label: "Contact email", type: "email", required: false, sellerColumn: "grievanceOfficerEmail" },
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
  stage: "business",
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

/**
 * How a fresh-produce shop runs day to day. Every field is OPTIONAL and lives in categoryData: these
 * tell the product editor and (later) the store-setup checklist how to behave, they are not paperwork
 * and must never stop a shop being submitted. Weight-based selling itself is NOT modelled here — it is
 * a LOOSE/PRODUCE variant in the standard catalogue (see the header note); `variableWeight` on the
 * profile is the default, this just records what the seller says they do.
 */
const FRESH_STEP: RequirementStep = {
  key: "fresh",
  title: "How you run fresh",
  subtitle: "Helps us set up the right tools for your products",
  stage: "business",
  fields: [
    { key: "freshSoldByWeight", label: "Do you sell products by weight?", type: "choice", required: false, options: ["Yes", "No"] },
    { key: "freshPackedOnPremises", label: "Do you prepare or pack fresh products at your store?", type: "choice", required: false, options: ["Yes", "No"] },
    { key: "freshStockChanges", label: "How often does your fresh stock change?", type: "choice", required: false, options: ["Daily", "Every few days", "Weekly"] },
    { key: "freshAvailability", label: "Are these products available every day?", type: "choice", required: false, options: ["Every day", "Only on some days"] },
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
  shop("FRUIT_VEG", "Fruit & vegetable shop", "Fresh", { variableWeight: true, extraSteps: [FSSAI_STEP, FRESH_STEP] }),
  shop("DAIRY", "Dairy shop", "Fresh", { extraSteps: [FSSAI_STEP, FRESH_STEP] }),
  shop("EGGS", "Egg shop", "Fresh", { extraSteps: [FSSAI_STEP, FRESH_STEP] }),
  shop("MEAT_FISH", "Meat, fish & poultry", "Fresh", { variableWeight: true, extraSteps: [FSSAI_STEP, FRESH_STEP] }),

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

// ─── Departments — what the seller actually PICKS ────────────────────────────────────────────────
// The wizard and the lead form show departments ("Grocery", "Fresh"), multi-select, with no
// sub-category. Each department stands in for ONE representative shop type, which is what decides the
// paperwork. The first pick becomes `shopType`, the rest `alsoSellCategories`.
//
// ⚠️ Representatives are chosen to be the type whose paperwork the WHOLE department shares — never a
// regulated one. Health is the case that bites: pharmacies and opticals sit together, so its rep is
// the unlicensed MEDICAL_SUPPLIES and the licensed lines are explicit yes/no extras below. Make
// "Health" imply PHARMACY instead and every optician is asked for a drug licence they cannot have.
export const DEPARTMENT_REP: Record<string, string> = {
  Grocery: "GENERAL_STORE",
  Fresh: "FRUIT_VEG",
  "Bakery & sweets": "BAKERY",
  Food: "RESTAURANT",
  Beauty: "PERSONAL_CARE",
  Fashion: "CLOTHING",
  "Books & stationery": "STATIONERY",
  "Toys & gifts": "TOYS",
  Electronics: "ELECTRONICS",
  Health: "MEDICAL_SUPPLIES",
  "Baby & kids": "BABY_STORE",
  Home: "HOME_KITCHEN",
  Hardware: "HARDWARE",
  Sports: "SPORTS",
  Pet: "PET",
  Garden: "NURSERY",
  Jewellery: "JEWELLERY",
  Automotive: "AUTO_PARTS",
};

/** A restaurant runs on a menu, not the standard catalogue, so it can't be combined with a shop. */
export const EXCLUSIVE_DEPARTMENTS = new Set(["Food"]);

/** Licensed lines inside a department, asked as plain yes/no — they add that trade's licence step. */
export const DEPARTMENT_EXTRAS: Record<string, { key: string; label: string }[]> = {
  Health: [
    { key: "PHARMACY", label: "I sell medicines (needs a drug licence)" },
    { key: "MEDICAL_DEVICE", label: "I sell medical devices (needs a licence)" },
  ],
};

/**
 * Lead-form category string ("Grocery,Fresh") → registry keys: first = shopType, rest = also-sell.
 * Unknown tokens are dropped (the old free-text leads contain things like "kirana"); an exclusive
 * department wins alone, since it can't be mixed. Returns null when nothing usable was found.
 */
export function categoriesFromLead(raw: string | null | undefined): { shopType: string; alsoSell: string[] } | null {
  const keys: string[] = [];
  let exclusive: string | null = null;
  for (const token of String(raw ?? "").split(",")) {
    const dept = Object.keys(DEPARTMENT_REP).find((d) => d.toLowerCase() === token.trim().toLowerCase());
    if (!dept) continue;
    if (EXCLUSIVE_DEPARTMENTS.has(dept)) exclusive = DEPARTMENT_REP[dept]!;
    else if (!keys.includes(DEPARTMENT_REP[dept]!)) keys.push(DEPARTMENT_REP[dept]!);
  }
  if (exclusive) return { shopType: exclusive, alsoSell: [] };
  if (keys.length === 0) return null;
  return { shopType: keys[0]!, alsoSell: keys.slice(1) };
}

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

/**
 * Core steps plus whatever this trade adds, ordered by stage so the progress strip only ever moves
 * forward (a pharmacy licence must not appear after "Where we pay you"). Array#sort is stable, so
 * steps keep their declared order within a stage. Every step comes back with `stage` filled in.
 */
export function stepsFor(profile: ShopTypeProfile): RequirementStep[] {
  return [...CORE_STEPS, ...(profile.extraSteps ?? [])]
    .map((s) => ({ ...s, stage: s.stage ?? ("verification" as StepStage) }))
    .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
}

/**
 * The profile a SELLER is actually held to: their primary trade plus the extra paperwork of every
 * trade they also sell (grocery + pharmacy → the drug licence is required too).
 *
 * ⚠️ Everything that asks "what does this seller owe us" — the requirements endpoint, the submit
 * gate, completion %, categoryData validation — must go through this, not profileFor. Two sources
 * of truth here means a seller shown a form the server then rejects, or one waved through without
 * the licence they declared. Unknown / same-as-primary / FOOD keys are ignored (a kitchen is a
 * different catalogue, not something a shop also is).
 */
export function effectiveProfile(
  shopType: string | null | undefined,
  vertical: string,
  alsoSell: readonly string[] | null | undefined = [],
): ShopTypeProfile {
  const base = profileFor(shopType, vertical);
  const extra = [...(base.extraSteps ?? [])];
  const seen = new Set(extra.map((s) => s.key));
  let regulated = Boolean(base.regulated);
  for (const key of alsoSell ?? []) {
    const other = BY_KEY.get(key);
    if (!other || other.key === base.key || other.vertical !== "SHOP") continue;
    for (const step of other.extraSteps ?? []) {
      if (seen.has(step.key)) continue;
      seen.add(step.key);
      extra.push(step);
    }
    regulated = regulated || Boolean(other.regulated);
  }
  return { ...base, extraSteps: extra, regulated };
}

/** True for keys valid in `alsoSellCategories` — a known SHOP trade (kitchens are a separate catalogue). */
export function isAlsoSellKey(key: string): boolean {
  return BY_KEY.get(key)?.vertical === "SHOP";
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
  const choices = new Map(fieldsFor(profile).filter((f) => f.type === "choice").map((f) => [f.key, f.options ?? []]));
  const unknownKeys: string[] = [];

  for (const [key, value] of Object.entries(incoming)) {
    // A "choice" answer outside its options is rejected the same way as a stray key (reported, not
    // stored) — otherwise a typo'd value would sit in the blob looking like a real answer.
    if (!allowed.has(key) || (choices.has(key) && !isBlank(value) && !choices.get(key)!.includes(String(value)))) {
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
