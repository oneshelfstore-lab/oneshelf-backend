import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ updateMany: vi.fn(async (_args: any) => ({ count: 1 })) }));
vi.mock("../../lib/prisma.js", () => ({ default: { notification: { updateMany: h.updateMany } } }));

import { ACTION_TTL_DAYS, actionCutoff, resolveActions } from "../notificationInbox.js";

beforeEach(() => h.updateMany.mockClear());

describe("resolveActions", () => {
  it("only touches unresolved ACTION rows of the named types, scoped to the entity", async () => {
    await resolveActions({ entityType: "ORDER", entityId: "o1", types: ["new_order"] });
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { kind: "ACTION", resolvedAt: null, type: { in: ["new_order"] }, entityType: "ORDER", entityId: "o1" },
      data: { resolvedAt: expect.any(Date) },
    });
  });

  it("narrows to one user when asked (one seller's card, not every seller's)", async () => {
    await resolveActions({ entityType: "ORDER", entityId: "o1", userId: "u1", types: ["sub_order_new"] });
    expect(h.updateMany.mock.calls[0]![0].where).toMatchObject({ userId: "u1", entityId: "o1" });
  });

  // An undefined id slipping through a caller must never clear everyone's notifications.
  it("refuses to run unscoped", async () => {
    await resolveActions({ entityType: "ORDER", entityId: undefined, types: ["new_order"] });
    await resolveActions({ types: ["new_order"] });
    await resolveActions({ entityType: "ORDER", entityId: "o1", types: [] });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("never throws, even when the database does", async () => {
    h.updateMany.mockRejectedValueOnce(new Error("db down"));
    await expect(resolveActions({ userId: "u1", types: ["partner_approved"] })).resolves.toBeUndefined();
  });
});

describe("actionCutoff", () => {
  it("is ACTION_TTL_DAYS back", () => {
    const now = Date.UTC(2026, 9, 20);
    expect(now - actionCutoff(now).getTime()).toBe(ACTION_TTL_DAYS * 86_400_000);
  });
});
