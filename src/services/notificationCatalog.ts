// What every push `type` MEANS for the in-app inbox: which tab it belongs to, whether the person has
// to act on it, how loud it is, and what it points at. The server stamps this on the Notification row
// so the app stops guessing from `type.contains("order")`.
//
// Pure data — no prisma/firebase imports — so it can be unit-tested and imported anywhere.
// ⚠️ Every `type: "..."` emitted by fcmNotifier.ts MUST have an entry here (or be in NOT_PERSISTED);
// __tests__/notificationCatalog.test.ts fails the build otherwise.

export type NotifCategory =
  | "ORDERS" | "DELIVERY" | "ROUTINES" | "PAYMENTS" | "INVENTORY"
  | "BUSINESS" | "ACCOUNT" | "SUPPORT" | "PROMO" | "SYSTEM";
export type NotifKind = "ACTION" | "STATUS" | "INFO" | "PROMO";
export type NotifSeverity = "NORMAL" | "HIGH" | "CRITICAL";

type Data = Record<string, string>;

export type CatalogEntry = {
  category: NotifCategory;
  /** A function when the same push type is sometimes actionable and sometimes not. */
  kind: NotifKind | ((d: Data) => NotifKind);
  severity?: NotifSeverity;
  /** What the notification is about + which key of the push payload holds its id. */
  entity?: { type: string; idKey: string };
  /** Deep-link key the app maps to a screen. */
  action?: string;
  /** The person can switch this off (see PREFERENCE_TOPICS). No topic = always delivered. */
  topic?: string;
};

const order = { type: "ORDER", idKey: "orderId" };
const complaint = { type: "COMPLAINT", idKey: "complaintId" };
const quote = { type: "QUOTE", idKey: "quoteId" };
const courier = { type: "COURIER", idKey: "bookingId" };
const variant = { type: "VARIANT", idKey: "variantId" };

export const CATALOG: Record<string, CatalogEntry> = {
  // ── Orders ──
  new_order: { category: "ORDERS", kind: "ACTION", entity: order, action: "PACK_ORDER" },
  sub_order_new: { category: "ORDERS", kind: "ACTION", entity: order, action: "PACK_ORDER" },
  sub_order_cancelled: { category: "ORDERS", kind: "INFO", entity: order, action: "OPEN_ORDER" },
  sub_order_packed: { category: "ORDERS", kind: "STATUS", entity: order, action: "OPEN_ORDER" },
  order_status: { category: "ORDERS", kind: "STATUS", entity: order, action: "OPEN_ORDER" },
  substitution_proposal: { category: "ORDERS", kind: "ACTION", severity: "HIGH", entity: order, action: "REVIEW_SUBSTITUTION" },
  substitution_response: { category: "ORDERS", kind: "INFO", entity: order, action: "OPEN_ORDER" },

  // ── Delivery (riders + the owner's exception view) ──
  delivery_assignment: { category: "DELIVERY", kind: "ACTION", entity: order, action: "OPEN_DELIVERY" },
  delivery_available: { category: "DELIVERY", kind: "ACTION", entity: order, action: "OPEN_DELIVERY" },
  delivery_arrived: { category: "DELIVERY", kind: "STATUS", entity: order, action: "OPEN_ORDER" },
  delivery_failed: { category: "DELIVERY", kind: "ACTION", severity: "CRITICAL", entity: order, action: "RESOLVE_DELIVERY" },
  delivery_unclaimed: { category: "DELIVERY", kind: "ACTION", severity: "CRITICAL", entity: order, action: "ASSIGN_RIDER" },
  cash_settlement_declared: { category: "PAYMENTS", kind: "ACTION", severity: "CRITICAL", entity: { type: "RIDER", idKey: "riderId" }, action: "CONFIRM_CASH" },
  document_expiry: { category: "ACCOUNT", kind: "ACTION", severity: "HIGH", action: "UPDATE_DOCUMENT" },
  rider_document_expired: { category: "ACCOUNT", kind: "ACTION", severity: "CRITICAL", entity: { type: "RIDER", idKey: "riderId" }, action: "OPEN_RIDER" },

  // ── Courier ──
  courier_available: { category: "DELIVERY", kind: "ACTION", entity: courier, action: "OPEN_COURIER" },
  courier_assigned: { category: "DELIVERY", kind: "ACTION", entity: courier, action: "OPEN_COURIER" },
  courier_update: { category: "DELIVERY", kind: "STATUS", entity: courier, action: "OPEN_COURIER" },
  courier_failed: { category: "DELIVERY", kind: "ACTION", severity: "CRITICAL", entity: courier, action: "OPEN_COURIER" },

  // ── Support: complaints, quotes, order chat ──
  complaint: { category: "SUPPORT", kind: "ACTION", severity: "HIGH", entity: complaint, action: "OPEN_COMPLAINT" },
  complaint_forwarded: { category: "SUPPORT", kind: "ACTION", severity: "HIGH", entity: complaint, action: "OPEN_COMPLAINT" },
  complaint_seller_response: { category: "SUPPORT", kind: "INFO", entity: complaint, action: "OPEN_COMPLAINT" },
  complaint_message: { category: "SUPPORT", kind: "INFO", entity: complaint, action: "OPEN_CHAT" },
  order_message: { category: "SUPPORT", kind: "INFO", entity: order, action: "OPEN_CHAT" },
  quote_request: { category: "SUPPORT", kind: "ACTION", entity: quote, action: "OPEN_QUOTE" },
  quote_message: { category: "SUPPORT", kind: "INFO", entity: quote, action: "OPEN_CHAT" },
  quote_ready: { category: "SUPPORT", kind: "ACTION", severity: "HIGH", entity: quote, action: "OPEN_QUOTE" },

  // ── Routines / subscriptions ──
  routine_held: { category: "ROUTINES", kind: "ACTION", severity: "HIGH", entity: { type: "ROUTINE", idKey: "subscriptionId" }, action: "REVIEW_ROUTINE" },
  routine_items_skipped: { category: "ROUTINES", kind: "INFO", topic: "routines" },
  routine_substituted: { category: "ROUTINES", kind: "INFO", topic: "routines" },
  routine_price_up: { category: "ROUTINES", kind: "INFO", topic: "routines" },
  subscription_skipped: { category: "ROUTINES", kind: "INFO", topic: "routines" },
  subscription_ending_soon: { category: "ROUTINES", kind: "INFO", topic: "routines" },
  subscription_low_balance: { category: "PAYMENTS", kind: "ACTION", severity: "HIGH", action: "TOP_UP_WALLET" },
  // A bill that was already auto-paid needs nothing from the customer; one that is "ready" does.
  subscription_statement: { category: "PAYMENTS", kind: (d) => (d.autoPaid === "true" ? "INFO" : "ACTION"), action: "OPEN_STATEMENT" },

  // ── Account / onboarding / catalog ──
  tier_up: { category: "ACCOUNT", kind: "INFO", topic: "loyalty" },
  seller_callback: { category: "ACCOUNT", kind: "INFO", severity: "HIGH" },
  partner_rejected: { category: "ACCOUNT", kind: "INFO", severity: "HIGH", action: "OPEN_ONBOARDING" },
  partner_approved: { category: "ACCOUNT", kind: (d) => (d.stage === "PROVISIONED" ? "ACTION" : "INFO"), severity: "HIGH", action: "OPEN_ONBOARDING" },
  product_decision: { category: "INVENTORY", kind: (d) => (d.approved === "false" ? "ACTION" : "INFO"), action: "OPEN_PRODUCTS" },
  back_in_stock: { category: "INVENTORY", kind: "INFO", topic: "back_in_stock" },

  // ── Payments, refunds, expiry (Phase 8) ──
  payment_failed: { category: "PAYMENTS", kind: "ACTION", severity: "HIGH", entity: order, action: "OPEN_ORDER" },
  refund_update: { category: "PAYMENTS", kind: "INFO", entity: order, action: "OPEN_ORDER" },
  wallet_credited: { category: "PAYMENTS", kind: "INFO", action: "OPEN_WALLET" },
  order_expired: { category: "ORDERS", kind: "INFO", entity: order, action: "OPEN_ORDER" },
  courier_delayed: { category: "DELIVERY", kind: "INFO", entity: courier, action: "OPEN_COURIER" },

  // ── Seller: stock and money (Phase 8) ──
  low_stock: { category: "INVENTORY", kind: "ACTION", entity: variant, action: "OPEN_PRODUCTS" },
  out_of_stock: { category: "INVENTORY", kind: "ACTION", severity: "HIGH", entity: variant, action: "OPEN_PRODUCTS" },
  seller_payout: { category: "BUSINESS", kind: "INFO" },
  commission_update: { category: "BUSINESS", kind: "INFO" },

  // ── Promotional (kept apart from everything transactional) ──
  broadcast: { category: "PROMO", kind: "PROMO" },
  abandoned_cart: { category: "PROMO", kind: "PROMO", action: "OPEN_CART", topic: "cart_reminders" },
};

/**
 * The ONLY things a person may switch off. Everything not tied to one of these (orders, delivery,
 * payments, every action request, support) is always delivered. Served to the app by
 * GET /me/notification-preferences, so a new topic needs no app release. Offers are deliberately absent:
 * they follow the MARKETING_COMMS consent, which stays the single source of truth for marketing.
 */
export const PREFERENCE_TOPICS = [
  { key: "routines", label: "Routine updates", description: "Skipped or swapped items and price changes on your routines" },
  { key: "back_in_stock", label: "Back in stock", description: "When an item you asked about is available again" },
  { key: "loyalty", label: "Membership", description: "Tier upgrades and perks" },
  { key: "cart_reminders", label: "Cart reminders", description: "A nudge when you leave items in your cart" },
] as const;

/** Pushes that are deliberately NOT written to the inbox. */
export const NOT_PERSISTED = new Set<string>([
  // Fires every few minutes for the length of a delivery; the app shows it as one self-replacing card.
  "rider_eta",
]);

export function resolveCatalog(data: Data): {
  category: NotifCategory;
  kind: NotifKind;
  severity: NotifSeverity;
  entityType: string | null;
  entityId: string | null;
  action: string | null;
  topic: string | null;
  known: boolean;
} {
  const e = CATALOG[data.type ?? ""];
  if (!e) {
    return { category: "SYSTEM", kind: "INFO", severity: "NORMAL", entityType: null, entityId: null, action: null, topic: null, known: false };
  }
  return {
    category: e.category,
    kind: typeof e.kind === "function" ? e.kind(data) : e.kind,
    severity: e.severity ?? "NORMAL",
    entityType: e.entity?.type ?? null,
    entityId: e.entity ? data[e.entity.idKey] || null : null,
    action: e.action ?? null,
    topic: e.topic ?? null,
    known: true,
  };
}
