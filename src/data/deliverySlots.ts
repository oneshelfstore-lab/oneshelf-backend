// Fixed delivery windows for routines. Display + delivery-run sort only — the engine still generates
// the day's orders once, early morning. Add a slot here and it is valid everywhere (no schema change).
export const DELIVERY_SLOTS = [
  { id: "MORNING", label: "7–9 AM", startHour: 7 },
  { id: "LATE_MORNING", label: "9–11 AM", startHour: 9 },
  { id: "AFTERNOON", label: "12–2 PM", startHour: 12 },
  { id: "EVENING", label: "5–7 PM", startHour: 17 },
  { id: "NIGHT", label: "7–9 PM", startHour: 19 },
] as const;

export type DeliverySlotId = (typeof DELIVERY_SLOTS)[number]["id"];
export const DELIVERY_SLOT_IDS = DELIVERY_SLOTS.map((s) => s.id) as [DeliverySlotId, ...DeliverySlotId[]];

/** Hour a slot starts (for sorting a run); unknown / missing slot sorts last. */
export function slotStartHour(id: string | null | undefined): number {
  return DELIVERY_SLOTS.find((s) => s.id === id)?.startHour ?? 99;
}

/** Earliest slot first, then pincode (area), then oldest first — the order a rider should drive a run. */
export function compareRunStops(
  a: { slotId?: string | null; pincode?: string | null; createdAt: Date },
  b: { slotId?: string | null; pincode?: string | null; createdAt: Date },
): number {
  return (
    slotStartHour(a.slotId) - slotStartHour(b.slotId) ||
    (a.pincode ?? "").localeCompare(b.pincode ?? "") ||
    a.createdAt.getTime() - b.createdAt.getTime()
  );
}
