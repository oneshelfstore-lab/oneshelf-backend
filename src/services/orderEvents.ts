import prisma from "../lib/prisma.js";

/**
 * The append-only order lifecycle log (FOOD_DELIVERY_MASTER.md §3.1, gap G1).
 *
 * Every state transition — on the Order OR on one seller's SubOrder — gets a row here, and nothing
 * ever updates or deletes one. `Order.status` holds only the LATEST state, so without this table
 * there is no answer to "what actually happened to #158", no evidence in a dispute, and — the part
 * that cannot be recovered later — no training data for prep-time and ETA prediction.
 *
 * ⚠️ SubOrder transitions are the important half for food. A food order's parent Order sits at
 * PLACED for the entire cook; the restaurant's accept and food-ready signals are SubOrder
 * transitions. Log only Order status and you capture nothing about prep time.
 */

export type OrderEventActor = "CUSTOMER" | "SELLER" | "DELIVERY" | "OWNER" | "SYSTEM";

export type OrderEventInput = {
  orderId: string;
  /** Set when the transition belongs to one seller's slice rather than the whole order. */
  subOrderId?: string | null;
  /** Null on creation events — there is no previous state. */
  fromState?: string | null;
  toState: string;
  actorType: OrderEventActor;
  actorId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** Anything with a `.orderEvent` — the real client or a `$transaction` tx. */
type EventClient = { orderEvent: { create: (args: any) => Promise<unknown> } };

/**
 * Records one transition. **Never throws.**
 *
 * ⚠️ Best-effort on purpose, exactly like the `notify*` calls: an order must never fail because its
 * audit row could not be written. A missing event is a hole in the history; a thrown error here
 * would be a customer's order rejected for a logging problem. The failure is logged so a broken log
 * cannot be silent (a `.catch(() => {})` here would be the "background task failed" bug all over
 * again).
 *
 * Pass the transaction client when the transition happens inside one, so the event commits or rolls
 * back with the state change it describes.
 */
export async function recordOrderEvent(
  client: EventClient | null,
  e: OrderEventInput,
): Promise<void> {
  try {
    await (client ?? prisma).orderEvent.create({
      data: {
        orderId: e.orderId,
        subOrderId: e.subOrderId ?? null,
        fromState: e.fromState ?? null,
        toState: e.toState,
        actorType: e.actorType,
        actorId: e.actorId ?? null,
        reason: e.reason ?? null,
        metadata: (e.metadata ?? undefined) as any,
      },
    });
  } catch (err) {
    console.error("[order event not recorded]", e.orderId, e.toState, err);
  }
}

/**
 * Fire-and-forget form for a transition already committed outside a transaction. Same semantics,
 * just without an await at the call site — used where the status write has already returned and the
 * handler is about to respond.
 */
export function recordOrderEventAsync(e: OrderEventInput): void {
  void recordOrderEvent(null, e);
}

/**
 * Maps an authenticated app role onto an actor type. `req.appUser.role` is the source; a request
 * with no role behind it (a sweeper, a webhook) is SYSTEM.
 *
 * Pure and exported so the mapping is pinned by test — mislabelling the actor makes the log useless
 * for exactly the dispute it exists to settle.
 */
export function actorFromRole(role: string | null | undefined): OrderEventActor {
  switch (role) {
    case "OWNER":
      return "OWNER";
    case "SELLER":
      return "SELLER";
    case "DELIVERY":
      return "DELIVERY";
    case "CUSTOMER":
      return "CUSTOMER";
    default:
      return "SYSTEM";
  }
}
