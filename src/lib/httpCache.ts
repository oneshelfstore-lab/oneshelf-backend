import type { RequestHandler } from "express";

/**
 * Lightweight HTTP-caching helpers for the read-heavy PUBLIC endpoints
 * (catalog, categories, super-categories, banners, brands, store config).
 *
 * Two complementary layers, both dependency-free:
 *
 *  1. `cacheControl(seconds)` — sets a `Cache-Control` header so the mobile
 *     OkHttp client can serve repeat reads straight from its disk cache
 *     (zero network) within the window, then cheaply revalidate after.
 *
 *  2. `memoCache` — a tiny in-process TTL store so repeated requests within
 *     the TTL skip Postgres entirely. This is what reduces *server / DB* load
 *     on the single Render free-tier instance. Owner/seller write paths call
 *     `memoCache.bust(prefix)` so edits are reflected server-instantly.
 *
 * Only PUBLIC, non-personalised, rarely-changing data is cached here. Auth'd /
 * per-user / mutating routes are never cached.
 */

// ─── Layer 1: Cache-Control header middleware ───────────────────────────

/**
 * `Cache-Control: public, max-age=<seconds>, stale-while-revalidate=<swr>`.
 * Lets the client (and any CDN) serve from cache for `seconds`, then serve
 * stale for up to `swr` more seconds while it revalidates in the background.
 */
export function cacheControl(seconds: number, swr = seconds * 5): RequestHandler {
  const value = `public, max-age=${seconds}, stale-while-revalidate=${swr}`;
  return (_req, res, next) => {
    res.setHeader("Cache-Control", value);
    next();
  };
}

// ─── Layer 2: in-memory TTL cache ───────────────────────────────────────

interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export const memoCache = {
  /**
   * Return the cached value for `key` if still fresh; otherwise run `loader`,
   * cache its result for `ttlMs`, and return it. `loader` failures are NOT
   * cached (they propagate so the caller can return the real error).
   */
  async get<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value as T;
    }
    const value = await loader();
    store.set(key, { value, expiresAt: now + ttlMs });
    return value;
  },

  /**
   * Drop every cache entry whose key === prefix or starts with `prefix + ":"`.
   * Called from owner/seller write paths so edits show up immediately.
   * Pass multiple prefixes to bust several namespaces at once.
   */
  bust(...prefixes: string[]): void {
    if (prefixes.length === 0) return;
    for (const key of store.keys()) {
      for (const prefix of prefixes) {
        if (key === prefix || key.startsWith(prefix + ":")) {
          store.delete(key);
          break;
        }
      }
    }
  },

  /** Test/diagnostic helper — clear everything. */
  clear(): void {
    store.clear();
  },
};

/** Default freshness window shared by the public read endpoints. */
export const PUBLIC_TTL_MS = 60 * 1000;
export const PUBLIC_TTL_SECONDS = 60;
