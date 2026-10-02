import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG, NOT_PERSISTED, PREFERENCE_TOPICS, resolveCatalog } from "../notificationCatalog.js";

describe("notification catalog", () => {
  // Fails the build when someone adds a push in fcmNotifier.ts and forgets its inbox classification.
  it("covers every push type emitted by fcmNotifier.ts", () => {
    const src = readFileSync("src/services/fcmNotifier.ts", "utf8"); // vitest runs from backend/
    const emitted = new Set([...src.matchAll(/\btype:\s*"([a-z_]+)"/g)].map((m) => m[1]!));
    expect(emitted.size).toBeGreaterThan(30);
    const missing = [...emitted].filter((t) => !CATALOG[t] && !NOT_PERSISTED.has(t));
    expect(missing).toEqual([]);
  });

  it("stamps entity id from the payload and falls back for unknown types", () => {
    expect(resolveCatalog({ type: "routine_held", subscriptionId: "s1" })).toMatchObject({
      kind: "ACTION", category: "ROUTINES", entityType: "ROUTINE", entityId: "s1", action: "REVIEW_ROUTINE",
    });
    expect(resolveCatalog({ type: "nope" })).toMatchObject({ category: "SYSTEM", kind: "INFO", known: false });
  });

  it("only asks for action when there is something to do", () => {
    expect(resolveCatalog({ type: "subscription_statement", autoPaid: "true" }).kind).toBe("INFO");
    expect(resolveCatalog({ type: "subscription_statement", autoPaid: "false" }).kind).toBe("ACTION");
    expect(resolveCatalog({ type: "product_decision", approved: "false" }).kind).toBe("ACTION");
    expect(resolveCatalog({ type: "product_decision", approved: "true" }).kind).toBe("INFO");
    expect(resolveCatalog({ type: "partner_approved", stage: "VERIFIED" }).kind).toBe("INFO");
  });
});

describe("preference topics", () => {
  it("every topic used by an entry is a listed, switchable topic", () => {
    const listed = new Set<string>(PREFERENCE_TOPICS.map((t) => t.key));
    const used = Object.entries(CATALOG).filter(([, e]) => e.topic).map(([, e]) => e.topic!);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((t) => !listed.has(t))).toEqual([]);
    expect([...listed].filter((t) => !used.includes(t))).toEqual([]); // no dead switches
  });

  // The promise made to customers: a request that needs them, or an order/payment/delivery update,
  // can never be switched off.
  it("never lets an action request or a core category be muted", () => {
    const core = new Set(["ORDERS", "DELIVERY", "PAYMENTS", "SUPPORT"]);
    for (const [type, e] of Object.entries(CATALOG)) {
      if (!e.topic) continue;
      expect(typeof e.kind === "function" ? "fn" : e.kind, `${type} is muteable but is an action`).not.toBe("ACTION");
      expect(core.has(e.category), `${type} is muteable but in core category ${e.category}`).toBe(false);
    }
  });
});
