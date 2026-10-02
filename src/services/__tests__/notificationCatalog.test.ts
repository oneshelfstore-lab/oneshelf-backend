import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG, NOT_PERSISTED, resolveCatalog } from "../notificationCatalog.js";

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
