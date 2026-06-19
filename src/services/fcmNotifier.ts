import { admin, isFirebaseInitialized } from "../lib/firebase.js";
import prisma from "../lib/prisma.js";

async function getUserTokens(userId: string): Promise<string[]> {
  const tokens = await prisma.fcmToken.findMany({
    where: { userId },
    select: { token: true },
  });
  return tokens.map(t => t.token);
}

async function sendToTokens(tokens: string[], data: Record<string, string>) {
  if (!isFirebaseInitialized() || tokens.length === 0) return;

  try {
    await admin.messaging().sendEachForMulticast({
      tokens,
      data,
      android: { priority: "high" },
    });
  } catch (e) {
    console.error("FCM send failed:", e);
  }
}

async function sendToTopic(topic: string, data: Record<string, string>) {
  if (!isFirebaseInitialized()) return;

  try {
    await admin.messaging().send({
      topic,
      data,
      android: { priority: "high" },
    });
  } catch (e) {
    console.error("FCM topic send failed:", e);
  }
}

// NOTE: messages are data-only (so the app's MyFirebaseMessagingService builds the
// notification consistently in foreground AND background). The app requires a
// non-blank title/body to display, so every payload below MUST include them.

function statusLabel(status: string): string {
  switch (status) {
    case "PLACED": return "Order placed";
    case "CONFIRMED": return "Order confirmed";
    case "PACKED": return "Order packed";
    case "OUT_FOR_DELIVERY": return "Out for delivery";
    case "READY_FOR_PICKUP": return "Ready for pickup";
    case "DELIVERED": return "Delivered";
    case "CANCELLED": return "Order cancelled";
    default: return status;
  }
}

export async function notifyNewOrder(order: { id: string; orderNumber: string; totalAmount: any; customerId: string }) {
  await sendToTopic("owner_orders", {
    type: "new_order",
    orderId: order.id,
    orderNumber: order.orderNumber,
    totalAmount: String(order.totalAmount),
    title: `New Order! #${order.orderNumber}`,
    body: `New order received — Rs.${Math.round(Number(order.totalAmount))}. Tap to pack.`,
  });
}

export async function notifyOrderStatusChange(order: { id: string; orderNumber: string; status: string; customerId: string }) {
  const tokens = await getUserTokens(order.customerId);
  await sendToTokens(tokens, {
    type: "order_status",
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    title: `Order #${order.orderNumber}`,
    body: statusLabel(order.status),
  });
}

export async function notifyDeliveryAssignment(order: { id: string; orderNumber: string }, agentId: string) {
  const tokens = await getUserTokens(agentId);
  await sendToTokens(tokens, {
    type: "delivery_assignment",
    orderId: order.id,
    orderNumber: order.orderNumber,
    title: "New delivery assigned",
    body: `Order #${order.orderNumber} is ready for delivery.`,
  });
}

export async function notifyDeliveryArrived(order: { id: string; orderNumber: string; customerId: string }) {
  const tokens = await getUserTokens(order.customerId);
  await sendToTokens(tokens, {
    type: "delivery_arrived",
    orderId: order.id,
    orderNumber: order.orderNumber,
    title: "Your delivery has arrived",
    body: `Your delivery is at your doorstep for Order #${order.orderNumber}. Please keep your handover code ready.`,
  });
}

export async function notifySubstitutionProposal(
  customerId: string,
  info: { orderId: string; orderNumber: string; originalItem: string; substituteItem: string; priceDelta: number },
) {
  const tokens = await getUserTokens(customerId);
  if (tokens.length === 0) return;

  const deltaText = info.priceDelta === 0
    ? "Same price"
    : info.priceDelta > 0
      ? `+Rs.${Math.round(info.priceDelta)}`
      : `-Rs.${Math.round(Math.abs(info.priceDelta))}`;

  await sendToTokens(tokens, {
    type: "substitution_proposal",
    orderId: info.orderId,
    orderNumber: info.orderNumber,
    title: `Substitution for Order #${info.orderNumber}`,
    body: `${info.originalItem} is unavailable. The store suggests ${info.substituteItem} (${deltaText}). Tap to review.`,
  });
}

export async function notifySubstitutionResponse(
  order: { id: string; orderNumber: string },
  substituteItem: string,
  action: "approved" | "rejected",
) {
  await sendToTopic("owner_orders", {
    type: "substitution_response",
    orderId: order.id,
    orderNumber: order.orderNumber,
    title: `Substitution ${action}`,
    body: `Customer ${action} the substitution of ${substituteItem} for Order #${order.orderNumber}.`,
  });
}

export async function notifyNewComplaint(info: { id: string; subject: string; customerName: string }) {
  await sendToTopic("owner_orders", {
    type: "complaint",
    complaintId: info.id,
    title: "New complaint",
    body: `${info.customerName}: ${info.subject}`,
  });
}

export async function notifyNewQuoteRequest(info: { id: string; type: string; customerName: string }) {
  await sendToTopic("owner_orders", {
    type: "quote_request",
    quoteId: info.id,
    title: "New quote request",
    body: `${info.customerName} requested a ${info.type} quote. Tap to send a price.`,
  });
}

/**
 * Owner broadcast → an FCM topic. Data-only (title/body in the data map) so the
 * app's MyFirebaseMessagingService builds the notification consistently in
 * foreground AND background — same convention as every payload above.
 */
export async function notifyBroadcast(topic: string, title: string, body: string) {
  await sendToTopic(topic, { type: "broadcast", title, body });
}

export async function notifyAbandonedCart(
  userId: string,
  info: { itemCount: number; cartValue: number; topItemName: string },
) {
  const tokens = await getUserTokens(userId);
  if (tokens.length === 0) return;

  const itemText = info.itemCount === 1
    ? info.topItemName
    : `${info.topItemName} and ${info.itemCount - 1} more`;

  await sendToTokens(tokens, {
    type: "abandoned_cart",
    title: "Your cart is waiting!",
    body: `${itemText} worth Rs.${info.cartValue} — complete your order before items sell out.`,
  });
}
