import { describe, it, expect } from "vitest";
import { resolveConsentState, type ConsentRow } from "../customerConsent.js";

const row = (consentType: string, granted: boolean, iso: string, version = "v1"): ConsentRow => ({
  consentType,
  version,
  granted,
  grantedAt: new Date(iso),
});

describe("resolveConsentState", () => {
  it("treats an absent record as NOT granted (no pre-ticked boxes — silence is a refusal)", () => {
    const s = resolveConsentState([], "v1");
    expect(s.granted.MARKETING_COMMS).toBe(false);
    expect(s.granted.LOCATION_USE).toBe(false);
    expect(s.granted.DIAGNOSTICS).toBe(false);
    expect(s.acceptedNoticeVersion).toBeNull();
    expect(s.needsNotice).toBe(true);
  });

  it("takes the LATEST row per purpose — a withdrawal must beat the earlier grant", () => {
    const s = resolveConsentState(
      [
        row("MARKETING_COMMS", false, "2026-07-20T10:00:00Z"),
        row("MARKETING_COMMS", true, "2026-07-01T10:00:00Z"),
      ],
      "v1",
    );
    expect(s.granted.MARKETING_COMMS).toBe(false);
  });

  it("a re-grant after a withdrawal wins again (order of the input array must not matter)", () => {
    const s = resolveConsentState(
      [
        row("LOCATION_USE", false, "2026-07-01T10:00:00Z"),
        row("LOCATION_USE", true, "2026-07-20T10:00:00Z"),
      ],
      "v1",
    );
    expect(s.granted.LOCATION_USE).toBe(true);
  });

  it("re-prompts when the accepted notice version is older than the current one", () => {
    const rows = [row("PRIVACY_NOTICE", true, "2026-07-01T10:00:00Z", "v1")];
    expect(resolveConsentState(rows, "v1").needsNotice).toBe(false);
    expect(resolveConsentState(rows, "v2").needsNotice).toBe(true);
  });

  it("a withdrawn notice acceptance does not count as accepted", () => {
    const s = resolveConsentState([row("PRIVACY_NOTICE", false, "2026-07-01T10:00:00Z", "v1")], "v1");
    expect(s.acceptedNoticeVersion).toBeNull();
    expect(s.needsNotice).toBe(true);
  });

  it("ignores partner consent types that share the ledger", () => {
    const s = resolveConsentState([row("PARTNER_AGREEMENT", true, "2026-07-01T10:00:00Z")], "v1");
    expect(s.needsNotice).toBe(true);
    expect(Object.keys(s.granted).sort()).toEqual(["DIAGNOSTICS", "LOCATION_USE", "MARKETING_COMMS"]);
  });
});
