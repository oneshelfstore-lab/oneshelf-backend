import { describe, it, expect } from "vitest";
import { shouldRefetch } from "../riderRoute.js";

// `shouldRefetch` decides how often we pay Google. Every failure here is silent on screen — too
// eager and the bill climbs with nothing new drawn, too lazy and the customer watches a route that
// no longer matches where the rider is. Hence a test on the predicate rather than on the fetch.

const DEST = { lat: 29.3812, lng: 78.1274 };
const NOW = 1_700_000_000_000;

function cached(overrides: Partial<{ fromLat: number; fromLng: number; destLat: number; destLng: number; at: number }> = {}) {
  return { fromLat: 29.3906, fromLng: 78.136, destLat: DEST.lat, destLng: DEST.lng, at: NOW, ...overrides };
}

describe("shouldRefetch", () => {
  it("fetches when nothing is cached", () => {
    expect(shouldRefetch(undefined, 29.3906, 78.136, DEST.lat, DEST.lng, NOW)).toBe(true);
  });

  it("serves the cache while the rider has barely moved", () => {
    // ~20 m up the road — a GPS twitch, not progress.
    expect(shouldRefetch(cached(), 29.39078, 78.136, DEST.lat, DEST.lng, NOW + 10_000)).toBe(false);
  });

  it("re-routes once the rider has genuinely moved on", () => {
    // ~0.004° of latitude ≈ 440 m, past the 250 m threshold.
    expect(shouldRefetch(cached(), 29.3946, 78.136, DEST.lat, DEST.lng, NOW + 10_000)).toBe(true);
  });

  it("re-routes on age even if the rider is stuck in one place", () => {
    expect(shouldRefetch(cached(), 29.3906, 78.136, DEST.lat, DEST.lng, NOW + 3 * 60 * 1000)).toBe(true);
  });

  it("re-routes when the destination itself changed", () => {
    expect(shouldRefetch(cached(), 29.3906, 78.136, 29.35, 78.1, NOW + 10_000)).toBe(true);
  });
});
