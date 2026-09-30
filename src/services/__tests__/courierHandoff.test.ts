import { describe, it, expect } from "vitest";
import { checkHandoff, afterWrongCode, refusalMessage, MAX_ATTEMPTS, GEOFENCE_M } from "../courierHandoff.js";

const NOW = 1_700_000_000_000;
const target = { lat: 29.37, lng: 78.13 };
// ~0.009° lat ≈ 1 km, so 0.0009 ≈ 100 m
const near = { lat: 29.37 + 0.0009, lng: 78.13 };
const far = { lat: 29.37 + 0.005, lng: 78.13 }; // ≈ 555 m

const base = { expectedCode: "482913", code: "482913", attempts: 0, lockedUntil: null, now: NOW, fix: near, target };

describe("checkHandoff", () => {
  it("accepts the right code from inside the geofence", () => {
    const r = checkHandoff(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.distanceM).toBeLessThan(GEOFENCE_M);
  });

  it("refuses the right code from outside the geofence (code read out over the phone)", () => {
    expect(checkHandoff({ ...base, fix: far })).toMatchObject({ ok: false, reason: "TOO_FAR" });
  });

  it("a location refusal is judged BEFORE the code, so it is not a wrong-code attempt", () => {
    // wrong code AND too far → tells the rider to go there; doesn't report the code as wrong
    expect(checkHandoff({ ...base, code: "000000", fix: far })).toMatchObject({ ok: false, reason: "TOO_FAR" });
  });

  it("refuses a fix too imprecise to trust", () => {
    expect(checkHandoff({ ...base, fix: { ...near, accuracyM: 400 } })).toMatchObject({ ok: false, reason: "POOR_GPS" });
    expect(checkHandoff({ ...base, fix: { ...near, accuracyM: 30 } }).ok).toBe(true);
  });

  it("wrong code inside the geofence reports attempts left", () => {
    const r = checkHandoff({ ...base, code: "111111", attempts: 1 });
    expect(r).toMatchObject({ ok: false, reason: "WRONG_CODE", attemptsLeft: MAX_ATTEMPTS - 2 });
  });

  it("a locked handoff refuses even the right code until the cooldown ends", () => {
    const lockedUntil = new Date(NOW + 30_000);
    expect(checkHandoff({ ...base, lockedUntil })).toMatchObject({ ok: false, reason: "LOCKED", retryInSec: 30 });
    expect(checkHandoff({ ...base, lockedUntil: new Date(NOW - 1) }).ok).toBe(true);
  });
});

describe("afterWrongCode", () => {
  it("counts up, then locks and resets on the Nth miss — never a permanent lock", () => {
    let s = { attempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      s = afterWrongCode(s.attempts, NOW);
      expect(s.lockedUntil).toBeNull();
    }
    s = afterWrongCode(s.attempts, NOW);
    expect(s.attempts).toBe(0);
    expect(s.lockedUntil!.getTime()).toBeGreaterThan(NOW);
  });
});

describe("refusalMessage", () => {
  it("tells the rider how far they are", () => {
    const r = checkHandoff({ ...base, fix: far });
    if (!r.ok) expect(refusalMessage(r)).toMatch(/\d+ m away/);
  });
});
