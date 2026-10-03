import { createHash } from "node:crypto";

/**
 * Rate-limit bucket for a signed-in caller: a hash of their bearer token, so one person's usage is their own.
 * Keying only on IP made everyone behind a shared address (mobile-carrier NAT, a shop's Wi-Fi) draw from one
 * 100/min pool — the Home screen alone fires a burst of calls. null = no bearer token (use the IP buckets).
 *
 * The token is hashed (never stored raw) and a token refresh (hourly) just starts a fresh bucket. A forged
 * token cannot dodge anything: it only moves the caller into a bucket of its own, and the per-IP backstop in
 * index.ts still counts every request regardless of what Authorization says.
 */
export function bearerBucket(authorization: string | undefined): string | null {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  return "t:" + createHash("sha256").update(token).digest("hex").slice(0, 32);
}
