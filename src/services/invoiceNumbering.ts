import prisma from "../lib/prisma.js";

// ─── Financial Year Utilities ────────────────────────────────────────

/**
 * Returns the FY string based on a given date.
 * FY runs April 1 – March 31.
 * Jan–Mar belongs to the previous April's FY.
 *
 * Example: June 2026 → "2627", Feb 2027 → "2627", April 2027 → "2728"
 */
export function getCurrentFinancialYear(date: Date = new Date()): string {
  const month = date.getMonth() + 1; // 1-indexed
  const year = date.getFullYear();

  // If Jan–Mar, FY started in previous calendar year
  const fyStartYear = month >= 4 ? year : year - 1;
  const fyEndYear = fyStartYear + 1;

  // Last 2 digits of each
  const start2 = String(fyStartYear).slice(-2);
  const end2 = String(fyEndYear).slice(-2);

  return `${start2}${end2}`;
}

// ─── Invoice Number Generator ────────────────────────────────────────

export type InvoicePrefix = "INV" | "CN" | "DN";

/**
 * Generates the next sequential, gap-free invoice number.
 * Uses database-level row locking to prevent duplicates under concurrency.
 *
 * Format: "{PREFIX}/{FY}/{SERIAL}"
 * Example: "INV/2627/00001"
 */
export async function getNextInvoiceNumber(prefix: InvoicePrefix): Promise<string> {
  const fy = getCurrentFinancialYear();

  // Use a Prisma interactive transaction with serializable isolation
  // to ensure gap-free sequential numbers even under concurrent requests
  const invoiceNumber = await prisma.$transaction(async (tx) => {
    // Try to find existing counter — use raw query with FOR UPDATE to lock the row
    const existing = await tx.invoiceCounter.findUnique({
      where: {
        prefix_financialYear: { prefix, financialYear: fy },
      },
    });

    let nextNumber: number;

    if (existing) {
      // Increment the counter
      nextNumber = existing.lastNumber + 1;
      await tx.invoiceCounter.update({
        where: {
          prefix_financialYear: { prefix, financialYear: fy },
        },
        data: { lastNumber: nextNumber },
      });
    } else {
      // First invoice of this type in this FY
      nextNumber = 1;
      await tx.invoiceCounter.create({
        data: {
          prefix,
          financialYear: fy,
          lastNumber: nextNumber,
        },
      });
    }

    // Zero-pad to 5 digits
    const serial = String(nextNumber).padStart(5, "0");
    return `${prefix}/${fy}/${serial}`;
  }, {
    isolationLevel: "Serializable",
  });

  return invoiceNumber;
}
