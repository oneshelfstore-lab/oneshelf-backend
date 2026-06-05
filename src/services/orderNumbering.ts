import prisma from "../lib/prisma.js";
import { getCurrentFinancialYear } from "./invoiceNumbering.js";

/**
 * Generates sequential order numbers: ONS/2627/00001
 * Uses the same InvoiceCounter table with prefix "ONS".
 */
export async function getNextOrderNumber(): Promise<string> {
  const fy = getCurrentFinancialYear();
  const prefix = "ONS";

  const orderNumber = await prisma.$transaction(async (tx) => {
    const existing = await tx.invoiceCounter.findUnique({
      where: { prefix_financialYear: { prefix, financialYear: fy } },
    });

    let nextNumber: number;

    if (existing) {
      nextNumber = existing.lastNumber + 1;
      await tx.invoiceCounter.update({
        where: { prefix_financialYear: { prefix, financialYear: fy } },
        data: { lastNumber: nextNumber },
      });
    } else {
      nextNumber = 1;
      await tx.invoiceCounter.create({
        data: { prefix, financialYear: fy, lastNumber: nextNumber },
      });
    }

    const serial = String(nextNumber).padStart(5, "0");
    return `${prefix}/${fy}/${serial}`;
  }, { isolationLevel: "Serializable" });

  return orderNumber;
}
