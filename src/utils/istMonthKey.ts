const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "2026-07" for the IST calendar date of `d` — the monthly grouping key for payroll/staff reports. */
export function istMonthKey(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
