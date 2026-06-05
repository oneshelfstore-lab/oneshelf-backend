import { z } from "zod";

// ─── GSTIN Checksum (Verhoeff-based) ────────────────────────────────

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function gstinChecksumValid(gstin: string): boolean {
  if (gstin.length !== 15) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const idx = GSTIN_CHARS.indexOf(gstin[i]!);
    if (idx < 0) return false;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = idx * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const checkIdx = (36 - (sum % 36)) % 36;
  return GSTIN_CHARS[checkIdx] === gstin[14];
}

// GSTIN: 2-digit state + 10-char PAN + 1 entity + 1Z + 1 checksum
const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/;

export function isValidGstin(gstin: string): { valid: boolean; error?: string } {
  if (gstin.length !== 15) return { valid: false, error: "GSTIN must be exactly 15 characters" };
  if (!GSTIN_FORMAT.test(gstin)) return { valid: false, error: "Invalid GSTIN format (expected: 2 digits + PAN + entity + Z + check)" };
  if (!gstinChecksumValid(gstin)) return { valid: false, error: "GSTIN checksum digit is invalid" };
  return { valid: true };
}

export function isUpGstin(gstin: string): { valid: boolean; error?: string } {
  const base = isValidGstin(gstin);
  if (!base.valid) return base;
  if (!gstin.startsWith("09")) return { valid: false, error: "GSTIN must start with '09' (Uttar Pradesh)" };
  return { valid: true };
}

export function extractPanFromGstin(gstin: string): string {
  return gstin.substring(2, 12);
}

// GSTIN zod schema
export const gstinSchema = z.string().length(15).refine(
  (v) => isValidGstin(v).valid,
  (v) => ({ message: isValidGstin(v).error || "Invalid GSTIN" }),
);

export const upGstinSchema = z.string().length(15).refine(
  (v) => isUpGstin(v).valid,
  (v) => ({ message: isUpGstin(v).error || "Invalid GSTIN" }),
);

// PAN: 5 letters + 4 digits + 1 letter
export const panSchema = z.string().regex(
  /^[A-Z]{5}\d{4}[A-Z]$/,
  "Invalid PAN format (expected: 10 chars, e.g. AAACR5055K)",
);

// Indian phone: 10 digits starting with 6-9
export const phoneSchema = z.string().regex(
  /^[6-9]\d{9}$/,
  "Phone must be 10 digits starting with 6-9",
);

// HSN code: 4-8 digits
export const hsnCodeSchema = z.string().regex(
  /^\d{4,8}$/,
  "HSN code must be 4-8 digits",
);

// Positive currency amount with max 2 decimals
export const amountSchema = z.number()
  .positive("Amount must be positive")
  .multipleOf(0.01, "Amount must have at most 2 decimal places");

// Non-negative currency
export const nonNegativeAmountSchema = z.number()
  .min(0, "Amount cannot be negative")
  .multipleOf(0.01, "Amount must have at most 2 decimal places");

// Email
export const emailSchema = z.string().email("Invalid email address");

// Date string YYYY-MM-DD
export const dateStringSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "Date must be in YYYY-MM-DD format",
);

// Pagination
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Search — capped at 100 chars to prevent DoS
export const searchSchema = z.string().max(100).optional();
