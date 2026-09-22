import prisma from "../lib/prisma.js";
import { ValidationError } from "../lib/errors.js";

/**
 * Filed GST periods, and what "filed" means to a report (runbook step 18).
 *
 * THE PROBLEM. Every return here is computed live from current data. GSTR-8 aggregates sub-orders
 * and excludes cancelled ones; GSTR-1 aggregates invoices and excludes cancelled ones. So cancelling
 * an October order silently changes what SEPTEMBER would produce — after September was filed, with
 * the old numbers, to the government.
 *
 * THE RULE. A reversal belongs to the period it HAPPENS in, not retroactively to the one it
 * reverses. Once a period is filed:
 *
 *   - its own figures are frozen: a row that was live when the period was filed stays in it, even
 *     if it has since been cancelled;
 *   - the cancellation appears instead in the CURRENT period, as a negative.
 *
 * ⚠️ That second half is not optional. Freezing alone would make the reversal vanish entirely —
 * the tax would be collected, reported, and then quietly never given back. Both halves or neither.
 *
 * ⚠️ Nothing here decides WHEN to file. Marking a period filed is an owner action, taken after the
 * return has actually been submitted, and it is deliberately not automatic: a period that marks
 * itself filed on the 11th would freeze numbers the owner had not yet looked at.
 */

export const RETURN_TYPES = {
  /** Outward supplies — invoices. */
  GSTR1: "GSTR1",
  /** Marketplace TCS — sub-orders. */
  GSTR8: "GSTR8",
} as const;

export type ReturnType = (typeof RETURN_TYPES)[keyof typeof RETURN_TYPES];

export function assertPeriod(period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new ValidationError("period must be YYYY-MM, e.g. 2026-09");
  return period;
}

/** The UTC half-open window for a YYYY-MM period. */
export function periodWindow(period: string): { start: Date; end: Date } {
  const [yy, mm] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(yy!, mm! - 1, 1)), end: new Date(Date.UTC(yy!, mm!, 1)) };
}

/** YYYY-MM for a date, in UTC. */
export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** When a period was filed, or null if it is still open. */
export async function filedAt(returnType: ReturnType, period: string): Promise<Date | null> {
  const row = await prisma.filedTaxPeriod.findUnique({
    where: { returnType_period: { returnType, period } },
    select: { filedAt: true },
  });
  return row?.filedAt ?? null;
}

/** Every filed period for a return, newest first. */
export async function listFiledPeriods(returnType?: ReturnType) {
  return prisma.filedTaxPeriod.findMany({
    where: returnType ? { returnType } : {},
    orderBy: [{ returnType: "asc" }, { period: "desc" }],
  });
}

/**
 * Mark a period filed.
 *
 * ⚠️ Refuses a period that has not ended. Freezing a month while orders are still being placed into
 * it would lock out figures that legitimately have not happened yet, and the resulting return would
 * be short by however much of the month was left.
 *
 * For GSTR-1 this also stamps `Invoice.gstr1Period` and `gstr1Filed` across the period's invoices.
 * ⚠️ Those columns have existed since the compliance work and were READ in two places and WRITTEN
 * by nothing — which means `issueCancellationCreditNote`, the code that is supposed to issue a
 * reversing credit note rather than silently cancel an already-filed invoice, has never once run.
 * Stamping them here is what makes that branch live.
 */
export async function markPeriodFiled(
  returnType: ReturnType,
  period: string,
  filedBy?: string | null,
  note?: string | null,
): Promise<{ returnType: string; period: string; filedAt: Date; invoicesStamped: number }> {
  assertPeriod(period);
  const { end } = periodWindow(period);
  if (Date.now() < end.getTime()) {
    throw new ValidationError(`${period} has not ended yet — filing it would freeze a month that is still receiving orders.`);
  }

  const existing = await prisma.filedTaxPeriod.findUnique({
    where: { returnType_period: { returnType, period } },
  });
  if (existing) {
    return { returnType, period, filedAt: existing.filedAt, invoicesStamped: 0 };
  }

  const row = await prisma.filedTaxPeriod.create({
    data: { returnType, period, filedBy: filedBy ?? null, note: note ?? null },
  });

  let invoicesStamped = 0;
  if (returnType === RETURN_TYPES.GSTR1) {
    const { start, end: e } = periodWindow(period);
    const r = await prisma.invoice.updateMany({
      where: { invoiceDate: { gte: start, lt: e }, status: { not: "CANCELLED" } },
      data: { gstr1Period: period, gstr1Filed: true },
    });
    invoicesStamped = r.count;
  }

  return { returnType, period, filedAt: row.filedAt, invoicesStamped };
}

/** Un-file a period. The owner's escape hatch for a filing marked in error, before the return goes out. */
export async function unmarkPeriodFiled(returnType: ReturnType, period: string): Promise<boolean> {
  assertPeriod(period);
  const deleted = await prisma.filedTaxPeriod.deleteMany({ where: { returnType, period } });
  if (deleted.count > 0 && returnType === RETURN_TYPES.GSTR1) {
    const { start, end } = periodWindow(period);
    await prisma.invoice.updateMany({
      where: { invoiceDate: { gte: start, lt: end }, gstr1Filed: true },
      data: { gstr1Filed: false },
    });
  }
  return deleted.count > 0;
}

/**
 * The cancellation cut-off a report should apply to a period.
 *
 * OPEN period  → null. Current status is the truth; a cancelled order simply is not in the return.
 * FILED period → the instant it was filed. An order cancelled AFTER that stays in the period, because
 *                that is what was reported; an order cancelled BEFORE it was correctly excluded then
 *                and stays excluded now.
 *
 * ⚠️ An order with a NULL `cancelledAt` is one cancelled before the column existed. It is treated as
 * cancelled-before-filing — excluded — which is both the pre-step-18 behaviour and the only safe
 * reading: no period has ever been filed, so no such row can be inside one.
 */
export async function cancellationCutoff(returnType: ReturnType, period: string): Promise<Date | null> {
  return filedAt(returnType, period);
}

/**
 * Reversals that belong in `period` because they happened in it, against a period already filed.
 *
 * Returns the filed periods whose rows may have been cancelled during `period`, so a report can add
 * the negatives. Empty while nothing has been filed, which is why step 18 changes no number today.
 */
export async function reversibleFiledPeriods(returnType: ReturnType, period: string) {
  const { start } = periodWindow(period);
  return prisma.filedTaxPeriod.findMany({
    // A period filed after the current one started cannot have been reversed during it.
    where: { returnType, period: { lt: period }, filedAt: { lt: new Date(Math.max(Date.now(), start.getTime())) } },
    select: { period: true, filedAt: true },
    orderBy: { period: "asc" },
  });
}
