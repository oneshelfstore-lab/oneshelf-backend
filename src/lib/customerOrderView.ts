// Pure helpers behind the customer's Orders screens: the cancel window and the per-shop breakdown.
// No Prisma here on purpose — every failure mode is silent on screen (a countdown that never ends,
// a shop labelled "C" that was "B" yesterday), so it is worth being unit-testable without mocking.

/** How long after placing a customer may cancel, wholly or one shop's part. Enforced SERVER-side. */
export const CUSTOMER_CANCEL_WINDOW_MS = 3 * 60 * 1000;

type CancelInput = {
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  createdAt: Date;
};

// An ONLINE/UPI order still awaiting payment has taken no money and no shop can see it yet (the
// seller list hides unpaid prepaid orders), so the 3-minute rule has nothing to protect there — a
// customer who abandons the payment screen must not be stuck with it until the 20-min sweeper.
function unpaidPrepaid(o: CancelInput): boolean {
  return (o.paymentMethod === "ONLINE" || o.paymentMethod === "UPI") && o.paymentStatus === "PENDING";
}

/** Whether the customer may cancel right now, and until when (null = no deadline applies). */
export function customerCancelInfo(o: CancelInput, now = Date.now()) {
  const statusOk = o.status === "PLACED" || o.status === "CONFIRMED";
  if (unpaidPrepaid(o)) return { canCancel: statusOk, cancelableUntil: null as Date | null };
  const until = new Date(o.createdAt.getTime() + CUSTOMER_CANCEL_WINDOW_MS);
  return { canCancel: statusOk && now <= until.getTime(), cancelableUntil: until };
}

export const CANCEL_WINDOW_MESSAGE =
  "Orders can be cancelled only within 3 minutes of placing them. Please use Chat to reach the store.";

type SubInput = {
  id: string;
  status: string;
  subtotal: unknown;
  packedAt: Date | null;
  collectedAt: Date | null;
  _count: { items: number };
  seller: { name: string; logoUrl: string | null; isHouse: boolean; vertical: string };
};

/**
 * One row per shop for the customer. `label` (A, B, C…) follows the array order the caller
 * fetched, which must be a stable sort (createdAt asc, id asc).
 *
 * `canCancel` is per shop: only while the shop has NOT accepted (PLACED) — once it accepts it may
 * already be packing — and only inside the window the parent order allows.
 */
export function shapeSubOrders(subs: SubInput[], orderCanCancel: boolean) {
  return subs.map((s, i) => ({
    id: s.id,
    label: String.fromCharCode(65 + (i % 26)),
    status: s.status,
    subtotal: Number(s.subtotal),
    itemCount: s._count.items,
    packedAt: s.packedAt,
    collectedAt: s.collectedAt,
    canCancel: orderCanCancel && s.status === "PLACED",
    seller: {
      name: s.seller.name,
      logoUrl: s.seller.logoUrl,
      isHouse: s.seller.isHouse,
      vertical: s.seller.vertical,
    },
  }));
}

/** "SHOP" | "FOOD" | "MIXED" — what the Orders service filter keys on. Empty (legacy order) reads SHOP. */
export function orderVertical(subs: { seller: { vertical: string } }[]): string {
  const kinds = new Set(subs.map((s) => s.seller.vertical));
  if (kinds.size === 0) return "SHOP";
  return kinds.size === 1 ? [...kinds][0] : "MIXED";
}
