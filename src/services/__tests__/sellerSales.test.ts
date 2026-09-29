import { describe, it, expect } from "vitest";
import { sellerAnalyticsWindows } from "../../routes/sellerAccount.js";

const AT = (iso: string) => new Date(iso);

describe("seller analytics windows", () => {
  it("'today' is compared with yesterday up to the same clock time, not the hours before midnight", () => {
    // 20:00 IST on 29 Sep.
    const now = AT("2026-09-29T14:30:00Z");
    const w = sellerAnalyticsWindows("today", now);
    expect(w.since.toISOString()).toBe("2026-09-28T18:30:00.000Z"); // 00:00 IST 29 Sep
    expect(w.prevSince.toISOString()).toBe("2026-09-27T18:30:00.000Z"); // 00:00 IST 28 Sep
    expect(w.prevUntil.toISOString()).toBe("2026-09-28T14:30:00.000Z"); // 20:00 IST 28 Sep
  });

  it("other ranges compare back-to-back equal windows", () => {
    const now = AT("2026-09-29T14:30:00Z");
    const w = sellerAnalyticsWindows("week", now);
    expect(w.since.toISOString()).toBe("2026-09-22T14:30:00.000Z");
    expect(w.prevSince.toISOString()).toBe("2026-09-15T14:30:00.000Z");
    expect(w.prevUntil.getTime()).toBe(w.since.getTime());
  });
});
