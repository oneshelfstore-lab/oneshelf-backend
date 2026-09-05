import { describe, it, expect, vi } from "vitest";
import { recordOrderEvent, actorFromRole } from "../orderEvents.js";

/**
 * The event log's whole value is that it is trustworthy and always present. Two silent failures:
 *   - a mislabelled actor makes the log useless for the dispute it exists to settle;
 *   - a THROWING logger would turn a logging problem into a failed customer order, which is far
 *     worse than the missing row it was trying to prevent.
 */

describe("actorFromRole", () => {
  it("maps each real app role to itself", () => {
    expect(actorFromRole("OWNER")).toBe("OWNER");
    expect(actorFromRole("SELLER")).toBe("SELLER");
    expect(actorFromRole("DELIVERY")).toBe("DELIVERY");
    expect(actorFromRole("CUSTOMER")).toBe("CUSTOMER");
  });

  it("falls back to SYSTEM for anything with no human behind it", () => {
    // Sweepers, webhooks and cron runs have no req.appUser at all.
    expect(actorFromRole(null)).toBe("SYSTEM");
    expect(actorFromRole(undefined)).toBe("SYSTEM");
    expect(actorFromRole("")).toBe("SYSTEM");
  });

  it("does not silently accept an unknown role as a real actor", () => {
    // A future role must read as SYSTEM rather than be recorded as a party that can be blamed.
    expect(actorFromRole("ACCOUNTANT")).toBe("SYSTEM");
    expect(actorFromRole("owner")).toBe("SYSTEM"); // case-sensitive: roles are upper-case on the wire
  });
});

describe("recordOrderEvent", () => {
  const client = (create: any) => ({ orderEvent: { create } });

  it("writes the transition through the client it is given", async () => {
    const create = vi.fn().mockResolvedValue({});
    await recordOrderEvent(client(create), {
      orderId: "o1",
      subOrderId: "s1",
      fromState: "ACCEPTED",
      toState: "PACKED",
      actorType: "SELLER",
      actorId: "seller-1",
      reason: "food ready",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data).toMatchObject({
      orderId: "o1",
      subOrderId: "s1",
      fromState: "ACCEPTED",
      toState: "PACKED",
      actorType: "SELLER",
      actorId: "seller-1",
      reason: "food ready",
    });
  });

  it("normalises every absent optional to null, never undefined", async () => {
    // A creation event has no previous state. Leaving these undefined would let Prisma fall back to
    // column defaults rather than storing an explicit "there was nothing here".
    const create = vi.fn().mockResolvedValue({});
    await recordOrderEvent(client(create), { orderId: "o1", toState: "PLACED", actorType: "CUSTOMER" });
    const { data } = create.mock.calls[0][0];
    expect(data.fromState).toBeNull();
    expect(data.subOrderId).toBeNull();
    expect(data.actorId).toBeNull();
    expect(data.reason).toBeNull();
  });

  it("NEVER throws when the write fails", async () => {
    // The one guarantee that matters. An order must not fail because its audit row could not be
    // written — a hole in the history beats a rejected order.
    const create = vi.fn().mockRejectedValue(new Error("db is down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordOrderEvent(client(create), { orderId: "o1", toState: "DELIVERED", actorType: "DELIVERY" }),
    ).resolves.toBeUndefined();
    // ...but it must not be silent either, or a broken log looks exactly like a working one.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
