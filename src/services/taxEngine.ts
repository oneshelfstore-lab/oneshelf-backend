import prisma from "../lib/prisma.js";

// ─── Constants ───────────────────────────────────────────────────────

/**
 * @deprecated Do NOT hardcode the store's state. The supplier / place-of-supply state code is derived
 * from the Company GSTIN — see `lib/stateCodes.ts` (`resolveStoreState` / `stateCodeFromGstin`). Kept
 * only as the legacy fallback default; no longer read anywhere (P0-1).
 */
export const STATE_CODE = "09";

/**
 * Identifies the GST rate ruleset used to compute an invoice; stamped onto `Invoice.taxRuleVersion` (P1c)
 * for audit traceability. Bump this whenever the rate schedule / `HsnMaster` defaults change. Old invoices
 * keep their original stamp — their computed amounts are already frozen per line item, so they never change.
 */
export const CURRENT_TAX_RULE_VERSION = "GST-2.0-2025-09-22";

// ─── Types ───────────────────────────────────────────────────────────

export interface LineItemTaxInput {
  unitPrice: number;
  quantity: number;
  discountPercent?: number;
  discountAmount?: number;
  gstRate: number;
  cessRate?: number;
  isTaxInclusive?: boolean;
  /** Inter-state supply → the full rate goes to IGST instead of CGST+SGST. Default false (P0-3). */
  isInterState?: boolean;
}

export interface LineItemTaxResult {
  grossAmount: number;
  discount: number;
  taxableValue: number;
  gstRate: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  igstRate: number;
  igstAmount: number;
  cessRate: number;
  cessAmount: number;
  totalAmount: number;
}

export interface InvoiceTotals {
  subtotal: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalCess: number;
  totalDiscount: number;
  roundOff: number;
  totalAmount: number;
  amountInWords: string;
}

export interface BackCalcResult {
  taxableValue: number;
  cgst: number;
  sgst: number;
  total: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Round to 2 decimal places using banker's rounding */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round to nearest rupee, max ±0.50 */
function calcRoundOff(amount: number): number {
  const rounded = Math.round(amount);
  const diff = round2(rounded - amount);
  if (Math.abs(diff) > 0.5) {
    // Should never happen with Math.round, but safety net
    return 0;
  }
  return diff;
}

// ─── 1. calculateLineItemTax ─────────────────────────────────────────

export function calculateLineItemTax(input: LineItemTaxInput): LineItemTaxResult {
  const {
    unitPrice,
    quantity,
    discountPercent = 0,
    discountAmount = 0,
    gstRate,
    cessRate = 0,
    isTaxInclusive = true,
    isInterState = false,
  } = input;

  // Gross amount before discount
  const grossAmount = round2(unitPrice * quantity);

  // Discount: use discountAmount if provided, else calculate from percent
  const discount =
    discountAmount > 0
      ? round2(discountAmount)
      : round2(grossAmount * discountPercent / 100);

  const amountAfterDiscount = round2(grossAmount - discount);

  // Taxable value depends on whether the price includes GST
  let taxableValue: number;
  if (isTaxInclusive && gstRate > 0) {
    // MRP includes GST: back-calculate taxable value
    taxableValue = round2(amountAfterDiscount / (1 + gstRate / 100));
  } else {
    taxableValue = amountAfterDiscount;
  }

  // Inter-state → full rate as IGST; intra-state → split equally into CGST + SGST.
  let cgstRate = 0, sgstRate = 0, cgstAmount = 0, sgstAmount = 0, igstRate = 0, igstAmount = 0;
  if (isInterState) {
    igstRate = gstRate;
    igstAmount = round2(taxableValue * gstRate / 100);
  } else {
    cgstRate = round2(gstRate / 2);
    sgstRate = round2(gstRate / 2);
    cgstAmount = round2(taxableValue * cgstRate / 100);
    sgstAmount = round2(taxableValue * sgstRate / 100);
  }

  // Cess (for sin goods like aerated drinks)
  const cessAmount = cessRate > 0 ? round2(taxableValue * cessRate / 100) : 0;

  // Total = taxable + all taxes
  const totalAmount = round2(taxableValue + cgstAmount + sgstAmount + igstAmount + cessAmount);

  return {
    grossAmount,
    discount,
    taxableValue,
    gstRate,
    cgstRate,
    cgstAmount,
    sgstRate,
    sgstAmount,
    igstRate,
    igstAmount,
    cessRate,
    cessAmount,
    totalAmount,
  };
}

// ─── 2. calculateInvoiceTotals ───────────────────────────────────────

export function calculateInvoiceTotals(lineItems: LineItemTaxResult[]): InvoiceTotals {
  let subtotal = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;
  let totalCess = 0;
  let totalDiscount = 0;

  for (const item of lineItems) {
    subtotal = round2(subtotal + item.taxableValue);
    totalCgst = round2(totalCgst + item.cgstAmount);
    totalSgst = round2(totalSgst + item.sgstAmount);
    totalIgst = round2(totalIgst + item.igstAmount);
    totalCess = round2(totalCess + item.cessAmount);
    totalDiscount = round2(totalDiscount + item.discount);
  }

  const preRound = round2(subtotal + totalCgst + totalSgst + totalIgst + totalCess);
  const roundOff = calcRoundOff(preRound);
  const totalAmount = round2(preRound + roundOff);

  return {
    subtotal,
    totalCgst,
    totalSgst,
    totalIgst,
    totalCess,
    totalDiscount,
    roundOff,
    totalAmount,
    amountInWords: convertAmountToWords(totalAmount),
  };
}

// ─── 3. convertAmountToWords ─────────────────────────────────────────

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];

const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
];

function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n]!;
  const ten = Math.floor(n / 10);
  const one = n % 10;
  return one > 0 ? `${TENS[ten]} ${ONES[one]}` : TENS[ten]!;
}

function threeDigitWords(n: number): string {
  if (n === 0) return "";
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  if (hundred > 0 && rest > 0) {
    return `${ONES[hundred]} Hundred ${twoDigitWords(rest)}`;
  }
  if (hundred > 0) {
    return `${ONES[hundred]} Hundred`;
  }
  return twoDigitWords(rest);
}

export function convertAmountToWords(amount: number): string {
  if (amount === 0) return "Zero Rupees Only";

  const isNegative = amount < 0;
  amount = Math.abs(amount);

  // Split into rupees and paise
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);

  if (rupees === 0 && paise === 0) return "Zero Rupees Only";

  // Indian number system: ones, thousands, lakhs, crores
  let rupeePart = "";

  if (rupees > 0) {
    const crore = Math.floor(rupees / 10000000);
    const lakh = Math.floor((rupees % 10000000) / 100000);
    const thousand = Math.floor((rupees % 100000) / 1000);
    const rest = rupees % 1000;

    const parts: string[] = [];
    if (crore > 0) parts.push(`${twoDigitWords(crore)} Crore`);
    if (lakh > 0) parts.push(`${twoDigitWords(lakh)} Lakh`);
    if (thousand > 0) parts.push(`${twoDigitWords(thousand)} Thousand`);
    if (rest > 0) parts.push(threeDigitWords(rest));

    rupeePart = parts.join(" ") + " Rupees";
  }

  let paisePart = "";
  if (paise > 0) {
    paisePart = `${twoDigitWords(paise)} Paise`;
  }

  let result = "";
  if (rupeePart && paisePart) {
    result = `${rupeePart} and ${paisePart}`;
  } else if (rupeePart) {
    result = rupeePart;
  } else {
    result = paisePart;
  }

  if (isNegative) result = `Minus ${result}`;

  return `${result} Only`;
}

// ─── 4. backCalculateFromMRP ─────────────────────────────────────────

export function backCalculateFromMRP(mrp: number, gstRate: number): BackCalcResult {
  const taxableValue = round2(mrp / (1 + gstRate / 100));
  const cgstRate = gstRate / 2;
  const sgstRate = gstRate / 2;
  const cgst = round2(taxableValue * cgstRate / 100);
  const sgst = round2(taxableValue * sgstRate / 100);
  const total = round2(taxableValue + cgst + sgst);

  return { taxableValue, cgst, sgst, total };
}

// ─── 5. getGstRateForProduct ─────────────────────────────────────────

export interface ProductGstInfo {
  gstRate: number;
  cessRate: number;
  hsnCode: string;
  isExempt: boolean;
}

export async function getGstRateForProduct(productId: string): Promise<ProductGstInfo> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!product) {
    throw new Error(`Product not found: ${productId}`);
  }

  // If product is explicitly exempt, return 0
  if (product.isExempt) {
    return {
      gstRate: 0,
      cessRate: 0,
      hsnCode: product.hsnCode,
      isExempt: true,
    };
  }

  // Product has its own GST rate set — use it directly
  // The rate was validated against HsnMaster at product creation time
  return {
    gstRate: Number(product.gstRate),
    cessRate: Number(product.cessRate),
    hsnCode: product.hsnCode,
    isExempt: false,
  };
}
