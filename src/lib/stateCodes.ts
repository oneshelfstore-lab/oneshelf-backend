import prisma from "./prisma.js";

/**
 * GST state / UT codes.
 *
 * The FIRST TWO DIGITS of any GSTIN encode the registered state (GST law), so the store's own state
 * is derived from its Company GSTIN — never hardcoded. Entering the correct Company GSTIN
 * auto-corrects place-of-supply everywhere (P0-1 of COMPLIANCE_PLAN.md).
 */
export const GST_STATE_NAMES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman and Diu (old)",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (old)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

/** Legacy fallback used only when the Company GSTIN is unset/placeholder (preserves pre-P0-1 output). */
export const DEFAULT_STATE_CODE = "09";

/** The 2-digit GST state code carried by a GSTIN's first two characters. */
export function stateCodeFromGstin(gstin?: string | null): string {
  const code = (gstin ?? "").trim().slice(0, 2);
  return /^\d{2}$/.test(code) && GST_STATE_NAMES[code] ? code : DEFAULT_STATE_CODE;
}

/** Human-readable state name for a 2-digit code. */
export function stateNameFromCode(code?: string | null): string {
  return (code && GST_STATE_NAMES[code]) || "Unknown";
}

/** "09-Uttar Pradesh" style label for GSTR-1 place-of-supply columns. */
export function stateLabel(code: string): string {
  return `${code}-${stateNameFromCode(code)}`;
}

export interface StoreState {
  /** 2-digit GST state code, e.g. "09". */
  code: string;
  /** State name, e.g. "Uttar Pradesh". */
  name: string;
}

// Small TTL memo (mirrors resolveLoyaltyConfig / resolveDeliveryPricingConfig). The store's state
// only changes when the owner edits the Company GSTIN; a 60s window self-heals, and bustStoreState()
// clears it immediately on a Company save.
let cached: StoreState | null = null;
let cachedAt = 0;
const TTL_MS = 60_000;

/**
 * The store's own state, derived from the Company GSTIN. Authoritative for the supplier state code on
 * house-issued invoices and for intra-state place-of-supply. Falls back to DEFAULT_STATE_CODE when the
 * Company row / GSTIN is missing (so behaviour is unchanged until a real GSTIN is entered).
 */
export async function resolveStoreState(): Promise<StoreState> {
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;
  const company = await prisma.company.findFirst({ select: { gstin: true } });
  const code = stateCodeFromGstin(company?.gstin);
  cached = { code, name: stateNameFromCode(code) };
  cachedAt = now;
  return cached;
}

/** Clear the store-state memo. Call after the Company GSTIN is created/updated. */
export function bustStoreState(): void {
  cached = null;
  cachedAt = 0;
}
