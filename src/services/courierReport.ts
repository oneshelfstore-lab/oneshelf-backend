/**
 * The owner's courier report — PURE aggregation over booking rows (COURIER_PLAN.md P5).
 *
 * Kept free of Prisma so the arithmetic (what counts as revenue, how a failure rate is defined, who
 * gets a rating average) is testable, and computed in JS because the window is bounded (the route
 * caps rows) and a courier booking has no per-line structure that would justify a SQL report.
 *
 * ⚠️ "Revenue" here is GROSS delivery + platform fees of DELIVERED bookings — GST on the courier fee
 * is still an open CA question (COURIER_PLAN.md §7), so this deliberately makes no net/tax claim.
 */

export interface ReportRow {
  status: string;
  total: number;
  deliveryFee: number;
  platformFee: number;
  createdAt: Date;
  acceptedAt: Date | null;
  deliveredAt: Date | null;
  riderId: string | null;
  ratingStars: number | null;
}

export interface RiderReportRow {
  riderId: string;
  name: string;
  delivered: number;
  failed: number;
  avgMinutes: number | null;
  avgRating: number | null;
  ratingCount: number;
}

export interface CourierReport {
  bookings: number;
  byStatus: Record<string, number>;
  delivered: number;
  cancelled: number;
  failed: number;
  /** failed / (delivered + failed) — a booking that was cancelled before a rider held it isn't a delivery attempt. Null until there is one. */
  failureRatePct: number | null;
  revenue: number;
  deliveryFees: number;
  platformFees: number;
  /** Booking placed → delivered, for delivered bookings. */
  avgDeliveryMinutes: number | null;
  avgRating: number | null;
  ratingCount: number;
  riders: RiderReportRow[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;

export function buildCourierReport(rows: ReportRow[], riderNames: Map<string, string>): CourierReport {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  const delivered = rows.filter((r) => r.status === "DELIVERED");
  const failed = rows.filter((r) => r.status === "FAILED").length;
  const cancelled = byStatus["CANCELLED"] ?? 0;
  const attempts = delivered.length + failed;

  const ratings = rows.filter((r) => r.ratingStars != null).map((r) => r.ratingStars as number);

  const perRider = new Map<string, ReportRow[]>();
  for (const r of rows) if (r.riderId) perRider.set(r.riderId, [...(perRider.get(r.riderId) ?? []), r]);
  const riders: RiderReportRow[] = [...perRider.entries()].map(([riderId, rs]) => {
    const done = rs.filter((r) => r.status === "DELIVERED");
    const rr = rs.filter((r) => r.ratingStars != null).map((r) => r.ratingStars as number);
    return {
      riderId,
      name: riderNames.get(riderId) ?? "Delivery partner",
      delivered: done.length,
      failed: rs.filter((r) => r.status === "FAILED").length,
      // Accept → delivered is the rider's own time; placed → delivered (above) includes the search wait.
      avgMinutes: mean(done.filter((r) => r.acceptedAt && r.deliveredAt).map((r) => minutesBetween(r.acceptedAt!, r.deliveredAt!))),
      avgRating: mean(rr),
      ratingCount: rr.length,
    };
  }).sort((a, b) => b.delivered - a.delivered || a.name.localeCompare(b.name));

  return {
    bookings: rows.length,
    byStatus,
    delivered: delivered.length,
    cancelled,
    failed,
    failureRatePct: attempts > 0 ? round1((failed / attempts) * 100) : null,
    revenue: round2(delivered.reduce((s, r) => s + r.total, 0)),
    deliveryFees: round2(delivered.reduce((s, r) => s + r.deliveryFee, 0)),
    platformFees: round2(delivered.reduce((s, r) => s + r.platformFee, 0)),
    avgDeliveryMinutes: mean(delivered.filter((r) => r.deliveredAt).map((r) => minutesBetween(r.createdAt, r.deliveredAt!))),
    avgRating: mean(ratings),
    ratingCount: ratings.length,
    riders,
  };
}
