import { describe, it, expect } from "vitest";
import { isSellerBusy, effectivePrepMinutes, isWithinWindow } from "../foodMenu.js";

const AT = (iso: string) => new Date(iso);

describe("isSellerBusy", () => {
  const now = AT("2026-09-06T12:00:00Z");

  it("is busy only while the expiry is still in the future", () => {
    expect(isSellerBusy(AT("2026-09-06T12:30:00Z"), now)).toBe(true);
    expect(isSellerBusy(AT("2026-09-06T11:30:00Z"), now)).toBe(false);
  });

  it("treats a never-set restaurant as not busy", () => {
    expect(isSellerBusy(null, now)).toBe(false);
    expect(isSellerBusy(undefined, now)).toBe(false);
  });

  // The whole point of storing an expiry rather than a boolean: a restaurant that taps "busy" and
  // goes home must recover on its own. A boolean would leave them ranked slow forever.
  it("expires without anyone clearing it", () => {
    const busyUntil = AT("2026-09-06T12:05:00Z");
    expect(isSellerBusy(busyUntil, AT("2026-09-06T12:04:59Z"))).toBe(true);
    expect(isSellerBusy(busyUntil, AT("2026-09-06T12:05:01Z"))).toBe(false);
  });
});

describe("effectivePrepMinutes", () => {
  const now = AT("2026-09-06T12:00:00Z");
  const future = AT("2026-09-06T13:00:00Z");
  const past = AT("2026-09-06T11:00:00Z");

  it("adds the extra only while busy", () => {
    expect(effectivePrepMinutes(25, future, 20, now)).toBe(45);
    expect(effectivePrepMinutes(25, past, 20, now)).toBe(25);
    expect(effectivePrepMinutes(25, null, 20, now)).toBe(25);
  });

  // A negative extra would SHORTEN the quote — the one direction busy mode must never move it.
  it("never shortens the estimate", () => {
    expect(effectivePrepMinutes(25, future, -30, now)).toBe(25);
  });
});

describe("isWithinWindow", () => {
  // IST = UTC+5:30. 04:30Z = 10:00 IST, 06:00Z = 11:30 IST, 20:00Z = 01:30 IST next day.
  it("no window set means always available", () => {
    expect(isWithinWindow(null, null, AT("2026-09-06T20:00:00Z"))).toBe(true);
  });

  it("honours a breakfast window in IST, not UTC", () => {
    expect(isWithinWindow("07:00", "11:00", AT("2026-09-06T04:30:00Z"))).toBe(true);  // 10:00 IST
    expect(isWithinWindow("07:00", "11:00", AT("2026-09-06T06:00:00Z"))).toBe(false); // 11:30 IST
  });

  // A close before the open is a past-midnight window (late-night counter), not bad data.
  it("handles a window that crosses midnight", () => {
    expect(isWithinWindow("18:00", "02:00", AT("2026-09-06T20:00:00Z"))).toBe(true);  // 01:30 IST
    expect(isWithinWindow("18:00", "02:00", AT("2026-09-06T04:30:00Z"))).toBe(false); // 10:00 IST
  });
});
