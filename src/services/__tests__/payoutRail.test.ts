import { describe, it, expect, vi, afterEach } from "vitest";
import { ManualRail, resolvePayoutRail } from "../payoutRail.js";

/**
 * One interface with one implementation, so there is little arithmetic to pin. What IS worth pinning
 * is the resolver's fallback: it is only safe because no rail can currently move money, and the day
 * that stops being true the fallback becomes a way for a config typo to silently stop transfers
 * while the owner believes they are going out. These assertions are the tripwire on that.
 */
describe("resolvePayoutRail", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the manual rail by name, case-insensitively", () => {
    expect(resolvePayoutRail("MANUAL")).toBe(ManualRail);
    expect(resolvePayoutRail("manual")).toBe(ManualRail);
  });

  it("defaults to the rail that moves no money when nothing is configured", () => {
    expect(resolvePayoutRail(null)).toBe(ManualRail);
    expect(resolvePayoutRail(undefined)).toBe(ManualRail);
  });

  // ⚠️ When a rail that genuinely sends exists, this must become a throw. Leaving it as a silent
  // fallback would mean a typo in StoreConfig.payoutRail stops payouts going out while every
  // SellerPayout row still says one happened.
  it("falls back to manual on an unknown rail, and says so out loud", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolvePayoutRail("RAZORPAY_ROUTE")).toBe(ManualRail);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no funds will move"));
  });
});

describe("ManualRail", () => {
  it("records without claiming anything was sent", async () => {
    const result = await ManualRail.send({
      payoutId: "p1",
      sellerId: "s1",
      sellerName: "bansal stationary",
      amount: 355.32,
      accountRef: null,
    });
    // RECORDED, never SENT — a human still has to move the money, and a payout row that claimed
    // otherwise would be the platform lying to itself about its own liabilities.
    expect(result.status).toBe("RECORDED");
    expect(result.reference).toBeUndefined();
  });

  it("carries the copy the cron used to hardcode", () => {
    expect(ManualRail.unattendedNote).toMatch(/manually/i);
  });
});
