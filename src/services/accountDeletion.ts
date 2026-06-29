import { createHash } from "node:crypto";
import prisma from "../lib/prisma.js";
import { ConflictError } from "../lib/errors.js";
import { admin, isFirebaseInitialized } from "../lib/firebase.js";
import { refundPayment, isRazorpayConfigured } from "./razorpay.js";

// Staff/owner roles are managed by the store and can never be self-deleted from the app.
const STAFF_ROLES = ["OWNER", "ACCOUNTANT", "BILLING_CLERK", "VIEWER"];

/** Start of "today" in IST, expressed in UTC — mirrors the delivery cash-summary window. */
function istTodayStartUtc(): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  return new Date(istMidnight - IST_OFFSET_MS);
}

/** Today's collected COD cash a delivery agent still owes the store (same basis as /cash-summary). */
async function sumTodayCodCash(userId: string): Promise<number> {
  const orders = await prisma.order.findMany({
    where: {
      deliveryBoyId: userId,
      paymentMethod: "COD",
      status: "DELIVERED",
      deliveredAt: { gte: istTodayStartUtc() },
    },
    select: { totalAmount: true },
  });
  return orders.reduce((sum, o) => sum + Number(o.totalAmount), 0);
}

/** Stable hash of a phone number (PII-minimising — we keep the hash, never the cleartext, post-purge). */
function hashPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (digits.length < 10) return null;
  return createHash("sha256").update(digits).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Account deletion (Phase 0) — safe, obligation-aware deletion.
//
// Deletion is REFUSED while the user has open obligations (active subscriptions,
// unsettled khata, a paid bulk-order advance, or in-flight orders). Wallet money is
// NOT lost: real money (Razorpay top-ups) is refunded to source (the user chose this
// policy — "Option B"); promotional credit (referral/scratch) is forfeited with a
// ledger row. We RETAIN financial/legal records (orders, invoices, wallet ledger,
// quote requests) and only scrub PII off the user row + revoke the Firebase credential.
// ─────────────────────────────────────────────────────────────────────────────

export interface DeletionBlocker {
  code: string;
  message: string;
}

export interface WalletDeletionSummary {
  balance: number;
  refundable: number; // real money (Razorpay top-ups) refunded to source
  forfeit: number; // promotional credit (referral/scratch/etc.) lost on deletion
}

interface RefundAllocation {
  paymentId: string;
  amount: number;
}

/**
 * Non-wallet obligations that must be cleared before an account can be deleted, PLUS the
 * "wallet refund unavailable" case (real money owed back but Razorpay isn't configured —
 * we won't delete and silently swallow the user's money). Wallet money that CAN be refunded
 * is handled by processWalletOnDeletion, not blocked.
 */
export async function getDeletionBlockers(userId: string): Promise<DeletionBlocker[]> {
  const blockers: DeletionBlocker[] = [];

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!user) return blockers;

  // Phase 4 — role-aware offboarding. CUSTOMER deletes freely (below). Staff/owner are store-managed.
  // SELLER must be wound down by the store (listings + payouts). DELIVERY can leave once nothing's
  // in their hands (no active assigned orders, no un-settled COD cash).
  if (STAFF_ROLES.includes(user.role)) {
    blockers.push({
      code: "STAFF_ACCOUNT",
      message: "Staff and owner accounts are managed by the store and can't be self-deleted. Please contact the store.",
    });
  } else if (user.role === "SELLER") {
    const seller = await prisma.seller.findUnique({
      where: { ownerUserId: userId },
      select: { outstandingBalance: true },
    });
    const owed = Number(seller?.outstandingBalance ?? 0);
    if (owed > 0) {
      blockers.push({
        code: "SELLER_PAYOUT_DUE",
        message: `You have a pending payout of ₹${owed.toFixed(0)} that must be settled first.`,
      });
    }
    blockers.push({
      code: "SELLER_ACCOUNT",
      message: "Seller accounts are closed through store offboarding (your listings and payouts are wound down). Please contact the store.",
    });
  } else if (user.role === "DELIVERY") {
    const [activeAssigned, codCash] = await Promise.all([
      prisma.order.count({
        where: { deliveryBoyId: userId, status: { in: ["PACKED", "OUT_FOR_DELIVERY"] } },
      }),
      sumTodayCodCash(userId),
    ]);
    if (activeAssigned > 0) {
      blockers.push({
        code: "DELIVERY_ACTIVE_ORDERS",
        message: `You have ${activeAssigned} active delivery order${activeAssigned > 1 ? "s" : ""}. Complete or hand them back before deleting.`,
      });
    }
    if (codCash > 0) {
      blockers.push({
        code: "DELIVERY_CASH_DUE",
        message: `Settle ₹${codCash.toFixed(0)} of collected COD cash with the store before deleting.`,
      });
    }
  }

  const [activeSubs, openStatements, advanceQuotes, inFlightOrders] = await Promise.all([
    prisma.subscription.count({
      where: { customerId: userId, status: { in: ["ACTIVE", "PAUSED"] } },
    }),
    prisma.subscriptionStatement.count({
      where: { customerId: userId, status: { in: ["OPEN", "BILLED", "PARTIALLY_PAID"] } },
    }),
    prisma.quoteRequest.count({
      where: { userId, paymentStatus: "ADVANCE_PAID" },
    }),
    prisma.order.count({
      where: {
        customerId: userId,
        OR: [{ status: { notIn: ["DELIVERED", "CANCELLED"] } }, { paymentStatus: "REFUND_INITIATED" }],
      },
    }),
  ]);

  if (activeSubs > 0) {
    blockers.push({
      code: "ACTIVE_SUBSCRIPTIONS",
      message: `Cancel your ${activeSubs} active subscription${activeSubs > 1 ? "s" : ""} before deleting your account.`,
    });
  }
  if (openStatements > 0) {
    blockers.push({
      code: "UNSETTLED_KHATA",
      message: "Please settle your pending subscription bill before deleting your account.",
    });
  }
  if (advanceQuotes > 0) {
    blockers.push({
      code: "ADVANCE_BALANCE_DUE",
      message: "You have a bulk order with a paid advance and a balance due. Complete or cancel it first.",
    });
  }
  if (inFlightOrders > 0) {
    blockers.push({
      code: "IN_FLIGHT_ORDERS",
      message: `You have ${inFlightOrders} order${inFlightOrders > 1 ? "s" : ""} in progress. Wait for delivery or cancel them before deleting.`,
    });
  }

  // Real-money wallet refund must be possible — otherwise we'd strand the user's money.
  const wallet = await analyzeWallet(userId);
  if (wallet.refundable > 0 && !isRazorpayConfigured()) {
    blockers.push({
      code: "WALLET_REFUND_UNAVAILABLE",
      message: "We can't process your wallet refund right now. Please contact the store.",
    });
  }

  return blockers;
}

/**
 * Splits the wallet balance into refundable-to-source (backed by Razorpay top-ups) vs
 * promotional credit (forfeited on deletion). Money is fungible, so refundable is capped at
 * min(currentBalance, Σ paid top-ups) — referral/scratch credit can't be refunded to a card.
 */
export async function analyzeWallet(userId: string): Promise<WalletDeletionSummary> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { walletBalance: true },
  });
  const balance = Number(user?.walletBalance ?? 0);
  if (balance <= 0) return { balance: Math.max(0, balance), refundable: 0, forfeit: 0 };

  const topups = await prisma.walletTopup.findMany({
    where: { userId, status: "PAID", razorpayPaymentId: { not: null } },
    select: { amount: true },
  });
  const topupTotal = topups.reduce((s, t) => s + Number(t.amount), 0);
  const refundable = Math.min(balance, topupTotal);
  const forfeit = Math.max(0, balance - refundable);
  return { balance, refundable, forfeit };
}

/** Per-payment refund plan: newest top-ups first, capped at the refundable balance. */
async function buildRefundAllocations(userId: string, refundable: number): Promise<RefundAllocation[]> {
  if (refundable <= 0) return [];
  const topups = await prisma.walletTopup.findMany({
    where: { userId, status: "PAID", razorpayPaymentId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { amount: true, razorpayPaymentId: true },
  });
  const allocations: RefundAllocation[] = [];
  let remaining = refundable;
  for (const t of topups) {
    if (remaining <= 0) break;
    const amt = Math.min(remaining, Number(t.amount));
    if (amt <= 0 || !t.razorpayPaymentId) continue;
    allocations.push({ paymentId: t.razorpayPaymentId, amount: amt });
    remaining -= amt;
  }
  return allocations;
}

/**
 * Refunds the real-money portion of the wallet to its Razorpay source and zeroes the balance,
 * writing signed ADJUSTMENT ledger rows (refund + promotional forfeiture) so the ledger stays
 * exact. Refunds run BEFORE anonymization and outside the db transaction (external API call) — a
 * refund failure throws so the account stays fully intact and the money is never lost.
 */
export async function processWalletOnDeletion(userId: string): Promise<WalletDeletionSummary> {
  const summary = await analyzeWallet(userId);
  if (summary.balance <= 0) return summary;

  if (summary.refundable > 0) {
    if (!isRazorpayConfigured()) {
      throw new ConflictError("We can't process your wallet refund right now. Please contact the store.");
    }
    const allocations = await buildRefundAllocations(userId, summary.refundable);
    for (const a of allocations) {
      // Throws on failure → caller aborts; account untouched, nothing ledgered yet.
      await refundPayment(a.paymentId, Math.round(a.amount * 100));
    }
  }

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.user.findUnique({ where: { id: userId }, select: { walletBalance: true } });
    const bal = Number(fresh?.walletBalance ?? 0);
    if (bal <= 0) return;
    if (summary.refundable > 0) {
      await tx.walletTransaction.create({
        data: {
          userId,
          amount: -summary.refundable,
          type: "ADJUSTMENT",
          balanceAfter: bal - summary.refundable,
          note: "Refunded to source on account deletion",
        },
      });
    }
    if (summary.forfeit > 0) {
      await tx.walletTransaction.create({
        data: {
          userId,
          amount: -summary.forfeit,
          type: "ADJUSTMENT",
          balanceAfter: 0,
          note: "Promotional credit forfeited on account deletion",
        },
      });
    }
    await tx.user.update({ where: { id: userId }, data: { walletBalance: 0 } });
  });

  return summary;
}

/**
 * Scrubs PII off the user row and removes transient/device state, while RETAINING records that
 * must survive for legal/financial/owner reasons (orders, invoices, wallet ledger, quote requests,
 * complaints — the Order→User relation is Restrict and invoices are kept for GST). Marks the row
 * DELETED. Returns the Firebase uid (if any) so the caller can revoke the credential afterwards.
 */
export async function anonymizeUser(userId: string): Promise<string | null> {
  let firebaseUid: string | null = null;
  await prisma.$transaction(async (tx) => {
    const u = await tx.user.findUnique({
      where: { id: userId },
      select: { firebaseUid: true, phone: true },
    });
    firebaseUid = u?.firebaseUid ?? null;
    // Keep a one-way hash of the number before scrubbing it (re-signup fraud throttle — Phase 5).
    const phoneHash = u?.phone ? hashPhone(u.phone) : null;

    // Transient / device state — safe to remove.
    await tx.address.deleteMany({ where: { userId } });
    await tx.cartItem.deleteMany({ where: { userId } });
    await tx.fcmToken.deleteMany({ where: { userId } });
    await tx.favorite.deleteMany({ where: { userId } });

    // NOTE: quoteRequests + complaints are RETAINED (a paid bulk-order advance is a financial
    // record; complaints are the owner's support history). PII is scrubbed via the user row below.
    // (The old delete-account path hard-deleted quoteRequests — that destroyed advance-payment proof.)
    await tx.user.update({
      where: { id: userId },
      data: {
        name: "Deleted User",
        email: null,
        phone: null,
        photoUrl: null,
        phoneVerified: false,
        isActive: false,
        firebaseUid: null,
        passwordHash: null,
        deletionStatus: "DELETED",
        deletedAt: null,
        phoneHash,
      },
    });
  });
  return firebaseUid;
}

/**
 * Best-effort deletion of the user's Firebase Storage files (profile photo + uploaded quote images,
 * both stored under uid-scoped prefixes per storage.rules). No-op unless FIREBASE_STORAGE_BUCKET is
 * configured; never throws (storage cleanup must not block the purge).
 */
async function cleanupUserStorage(firebaseUid: string | null): Promise<void> {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!firebaseUid || !bucketName || !isFirebaseInitialized()) return;
  try {
    const bucket = admin.storage().bucket(bucketName);
    await bucket.deleteFiles({ prefix: `profile_photos/${firebaseUid}/` });
    await bucket.deleteFiles({ prefix: `quote_requests/${firebaseUid}/` });
  } catch (err: any) {
    console.warn("Storage cleanup failed (non-fatal):", err?.message);
  }
}

/** Best-effort audit row for a deletion lifecycle event (never throws — audit must not block). */
async function writeDeletionAudit(userId: string, event: string, details: Record<string, unknown>): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action: "DELETE",
        entityType: "User",
        entityId: userId,
        newValues: { event, ...details },
      },
    });
  } catch (err: any) {
    console.warn("Deletion audit write failed (non-fatal):", err?.message);
  }
}

export interface DeletionRequestResult {
  graceDays: number;
  wallet: WalletDeletionSummary;
}

/**
 * Phase 2 — soft-delete: refuse if any obligation is open, otherwise mark the account
 * PENDING_DELETION and start the grace clock. Money + records are LEFT INTACT during the window so
 * the user can restore (the wallet is refunded + PII scrubbed only at purge — see purgeExpiredDeletions).
 * Throws ConflictError (409) with a readable message when blocked.
 */
export async function requestAccountDeletion(userId: string): Promise<DeletionRequestResult> {
  const blockers = await getDeletionBlockers(userId);
  if (blockers.length > 0) {
    throw new ConflictError(blockers.map((b) => b.message).join(" "));
  }

  const [wallet, cfg] = await Promise.all([
    analyzeWallet(userId),
    prisma.storeConfig.findFirst({ select: { accountDeletionGraceDays: true } }),
  ]);
  const graceDays = cfg?.accountDeletionGraceDays ?? 15;

  await prisma.user.update({
    where: { id: userId },
    data: { deletionStatus: "PENDING_DELETION", deletedAt: new Date() },
  });
  await writeDeletionAudit(userId, "requested", {
    graceDays,
    walletRefundable: wallet.refundable,
    walletForfeit: wallet.forfeit,
  });

  return { graceDays, wallet };
}

/** Restore a soft-deleted account within its grace window (the "sign in again to cancel" path). */
export async function cancelAccountDeletion(userId: string): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, deletionStatus: "PENDING_DELETION" },
    data: { deletionStatus: "ACTIVE", deletedAt: null },
  });
}

/**
 * Phase 2 sweeper — permanently finalizes soft-deleted accounts whose grace window has elapsed:
 * refund/forfeit wallet → scrub PII (retaining records) → revoke the Firebase credential. The
 * wallet refund runs BEFORE anonymization and throws on failure, so a user whose money can't yet be
 * refunded (e.g. Razorpay momentarily down) is skipped and retried on the next sweep — never purged
 * with money still owed. Returns the number of accounts fully purged.
 */
export async function purgeExpiredDeletions(): Promise<number> {
  const cfg = await prisma.storeConfig.findFirst({ select: { accountDeletionGraceDays: true } });
  const graceDays = cfg?.accountDeletionGraceDays ?? 15;
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

  const due = await prisma.user.findMany({
    where: { deletionStatus: "PENDING_DELETION", deletedAt: { lte: cutoff } },
    select: { id: true },
  });

  let purged = 0;
  for (const u of due) {
    try {
      const wallet = await processWalletOnDeletion(u.id); // refund real money first; throws → skip + retry
      const firebaseUid = await anonymizeUser(u.id);
      await cleanupUserStorage(firebaseUid); // best-effort Firebase Storage scrub (profile photo + quote images)
      if (firebaseUid && isFirebaseInitialized()) {
        try {
          await admin.auth().deleteUser(firebaseUid);
        } catch (err: any) {
          console.warn("Firebase user deletion failed (data already anonymized):", err?.message);
        }
      }
      await writeDeletionAudit(u.id, "purged", {
        walletRefunded: wallet.refundable,
        walletForfeited: wallet.forfeit,
      });
      purged++;
    } catch (err) {
      console.error(
        JSON.stringify({ level: "error", msg: "account purge failed (will retry)", userId: u.id, err: String(err) }),
      );
    }
  }

  if (purged > 0) {
    console.log(JSON.stringify({ level: "info", msg: "accounts purged", count: purged }));
  }
  return purged;
}

/** In-process backup driver (the internal cron POST /internal/subscriptions/run is the reliable one). */
export function startAccountDeletionSweeper(intervalMs = 6 * 60 * 60 * 1000): void {
  const timer = setInterval(() => {
    purgeExpiredDeletions().catch((e) =>
      console.error(JSON.stringify({ level: "error", msg: "account-deletion sweep crashed", err: String(e) })),
    );
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
