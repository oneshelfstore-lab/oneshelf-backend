import { admin, isFirebaseInitialized } from "./firebase";

/**
 * Short-lived signed URLs for privacy-sensitive Storage objects (a photo of the customer's front
 * door, their recorded voice, a photo of their home at handover).
 *
 * WHY THIS EXISTS — the thing it replaces: the app used to call `ref.downloadUrl` at upload time,
 * which mints a PERMANENT `?alt=media&token=…` URL. A Storage download token bypasses
 * storage.rules entirely, so anyone who ever obtained that URL (a forwarded support thread, a
 * crash report, a log line) could fetch the file forever, signed in or not. The app now stores the
 * bare object PATH on the order and we mint a expiring signed URL at read time instead.
 *
 * Signing is a LOCAL crypto operation against the service-account private key — it makes no
 * network call to GCS. Signing a 50-order page (~150 URLs) costs sub-millisecond each, so there's
 * no N+1 to engineer around. This is why the helper is called inline per row rather than batched.
 *
 * ⚠️ Requires a real service-account credential (`admin.credential.cert`, see lib/firebase.ts) —
 * `applicationDefault()` would need the `iam.serviceAccounts.signBlob` IAM permission instead.
 * If FIREBASE_STORAGE_BUCKET is unset or Firebase never initialized, every call degrades to null
 * (the media silently disappears) rather than throwing — a missing gate photo must never 500 an
 * order read.
 */

/** 6h: long enough that a delivery agent who opened an order at the depot can still load the gate
 *  photo at the door hours later, short enough that a leaked URL dies the same day. */
const MEDIA_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The three-way decision for a stored media value, extracted as a PURE function so it can be
 * tested without mocking Prisma or the Firebase Admin SDK (this repo has no `vi.mock` precedent —
 * every existing service test is a pure-function test).
 *
 *  - `empty`       → null/blank, nothing to serve.
 *  - `passthrough` → already an absolute URL. Legacy rows written before this change hold a full
 *                    `https://firebasestorage.googleapis.com/…?token=…`; `file://` shows up from
 *                    the app's mock/offline mode. Both are returned untouched, which is what makes
 *                    this change need NO data backfill — old orders keep working, only NEW uploads
 *                    get the expiring treatment.
 *  - `sign`        → a bare object path from a post-change upload; mint a signed URL.
 */
export function classifyStoredMedia(value: string | null | undefined): "empty" | "passthrough" | "sign" {
  if (!value || !value.trim()) return "empty";
  if (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("file://") ||
    value.startsWith("content://")
  ) {
    return "passthrough";
  }
  return "sign";
}

/** Turns a stored Storage object path into a time-limited signed URL. */
export async function signStoragePath(
  value: string | null | undefined,
  ttlMs: number = MEDIA_TTL_MS,
): Promise<string | null> {
  const kind = classifyStoredMedia(value);
  if (kind === "empty") return null;
  if (kind === "passthrough") return value!;

  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName || !isFirebaseInitialized()) return null;

  try {
    const [url] = await admin
      .storage()
      .bucket(bucketName)
      .file(value!)
      .getSignedUrl({ version: "v4", action: "read", expires: Date.now() + ttlMs });
    return url;
  } catch (e) {
    console.error(`[signStoragePath] failed for "${value}":`, (e as Error).message);
    return null;
  }
}

/** The order-media fields this helper rewrites. Kept loose so it accepts a Prisma row, a
 *  `select`ed subset, or an already-spread response object. */
type OrderMedia = {
  gatePhotoUrl?: string | null;
  voiceNoteUrl?: string | null;
  deliveryProofPhotoUrl?: string | null;
};

/**
 * Returns a copy of `order` with its three media fields swapped from stored paths to signed URLs.
 * Fields the caller didn't `select` are left absent (not set to null), so this is safe to spread
 * over any order shape.
 */
export async function signOrderMedia<T extends OrderMedia>(order: T): Promise<T> {
  const [gate, voice, proof] = await Promise.all([
    "gatePhotoUrl" in order ? signStoragePath(order.gatePhotoUrl) : Promise.resolve(undefined),
    "voiceNoteUrl" in order ? signStoragePath(order.voiceNoteUrl) : Promise.resolve(undefined),
    "deliveryProofPhotoUrl" in order
      ? signStoragePath(order.deliveryProofPhotoUrl)
      : Promise.resolve(undefined),
  ]);

  const out = { ...order };
  if (gate !== undefined) out.gatePhotoUrl = gate;
  if (voice !== undefined) out.voiceNoteUrl = voice;
  if (proof !== undefined) out.deliveryProofPhotoUrl = proof;
  return out;
}

/** List variant of [signOrderMedia]. */
export async function signOrderMediaList<T extends OrderMedia>(orders: T[]): Promise<T[]> {
  return Promise.all(orders.map(signOrderMedia));
}

/** 24h, not the order-media default of 6h. A user's own photo is read far less often per session
 *  than an order screen — `GET /me` isn't refetched on every tap — so the shorter TTL would let a
 *  cached avatar silently break mid-session once the URL expires. Still expires same-day. */
const USER_PHOTO_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Same treatment as order media, applied to `User.photoUrl` (M-5 of SECURITY_AUDIT_2026-08.md — the
 * one bucket still minting permanent `ref.downloadUrl` tokens as of the Aug 2026 audit). The app now
 * uploads and stores the bare object path; this signs it at read time. Legacy rows still holding a
 * full `https://…?token=…` from before this change pass through unchanged via [classifyStoredMedia]
 * — no backfill needed, only new uploads get the expiring treatment.
 *
 * A user's own photo has exactly one consumer shape (a `User` row with `photoUrl`), unlike order
 * media's three sibling fields, so this is a single-field version of [signOrderMedia] rather than a
 * reason to generalise that one.
 */
export async function signUserPhoto<T extends { photoUrl?: string | null }>(user: T): Promise<T> {
  if (!("photoUrl" in user)) return user;
  const signed = await signStoragePath(user.photoUrl, USER_PHOTO_TTL_MS);
  return { ...user, photoUrl: signed };
}
