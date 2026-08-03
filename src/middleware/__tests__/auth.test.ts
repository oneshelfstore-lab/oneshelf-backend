import { describe, it, expect } from "vitest";
import type { UserRole } from "@prisma/client";
// JWT_SECRET is supplied by vitest.config.ts's `test.env` — middleware/auth.ts hard-fails at import
// time without one. Set it there, not here: a top-level `await import()` would satisfy vitest's ESM
// runner but is a tsc error under this project's CommonJS target.
import {
  STAFF_ROLES,
  BILLING_ROLES,
  FINANCE_ROLES,
  requireRole,
  requirePasswordChanged,
  isTokenRevoked,
} from "../auth.js";

/** Minimal express doubles — this repo has no mocking precedent, and none is needed: the
 *  middleware only ever reads req.user and calls res.status().json() or next(). */
function runMiddleware(mw: any, user: any) {
  const result = { status: 0, body: null as any, nextCalled: false };
  const req: any = { user };
  const res: any = {
    status(code: number) { result.status = code; return res; },
    json(body: any) { result.body = body; return res; },
  };
  mw(req, res, () => { result.nextCalled = true; });
  return result;
}

const APP_ROLES: UserRole[] = ["CUSTOMER", "DELIVERY", "SELLER"];

describe("dashboard role sets", () => {
  it("STAFF_ROLES excludes every app-side role", () => {
    // The whole point of the global /api gate: a customer/rider/seller must never reach the
    // billing dashboard, whatever a future router forgets to do.
    for (const role of APP_ROLES) {
      expect(STAFF_ROLES).not.toContain(role);
    }
    expect(STAFF_ROLES).toEqual(["OWNER", "ACCOUNTANT", "BILLING_CLERK", "VIEWER"]);
  });

  it("FINANCE_ROLES excludes VIEWER and BILLING_CLERK", () => {
    // Credit/debit notes, payroll, vendors and TDS hang off this set. Widening it is exactly the
    // regression this test exists to catch.
    expect(FINANCE_ROLES).not.toContain("VIEWER");
    expect(FINANCE_ROLES).not.toContain("BILLING_CLERK");
    expect(FINANCE_ROLES).toEqual(["OWNER", "ACCOUNTANT"]);
  });

  it("BILLING_ROLES excludes VIEWER", () => {
    expect(BILLING_ROLES).not.toContain("VIEWER");
  });

  it("the sets are strictly nested: FINANCE ⊂ BILLING ⊂ STAFF", () => {
    for (const r of FINANCE_ROLES) expect(BILLING_ROLES).toContain(r);
    for (const r of BILLING_ROLES) expect(STAFF_ROLES).toContain(r);
  });
});

describe("requireRole", () => {
  it("passes an allowed role through", () => {
    const r = runMiddleware(requireRole(...FINANCE_ROLES), { role: "ACCOUNTANT" });
    expect(r.nextCalled).toBe(true);
    expect(r.status).toBe(0);
  });

  it("403s a disallowed role", () => {
    const r = runMiddleware(requireRole(...FINANCE_ROLES), { role: "VIEWER" });
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("FORBIDDEN");
  });

  it("401s when unauthenticated (no req.user)", () => {
    const r = runMiddleware(requireRole(...STAFF_ROLES), undefined);
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(401);
  });

  it("blocks a CUSTOMER token from the dashboard", () => {
    const r = runMiddleware(requireRole(...STAFF_ROLES), { role: "CUSTOMER" });
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(403);
  });
});

describe("requirePasswordChanged", () => {
  it("blocks while the seeded/reset password is still in place", () => {
    const r = runMiddleware(requirePasswordChanged, { role: "OWNER", mustChangePassword: true });
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("allows once the password has been changed", () => {
    const r = runMiddleware(requirePasswordChanged, { role: "OWNER", mustChangePassword: false });
    expect(r.nextCalled).toBe(true);
  });

  it("allows when the flag is absent (tokens issued before this field existed)", () => {
    const r = runMiddleware(requirePasswordChanged, { role: "OWNER" });
    expect(r.nextCalled).toBe(true);
  });
});

describe("isTokenRevoked", () => {
  it("accepts a token whose version matches the stored one", () => {
    expect(isTokenRevoked(3, 3)).toBe(false);
  });

  it("rejects a token issued before the stored version was bumped", () => {
    expect(isTokenRevoked(2, 3)).toBe(true);
  });

  // The backward-compat rule, and the reason this is a function rather than an inline comparison.
  // Tokens minted before tokenVersion shipped carry `undefined`; the column defaults to 0. If this
  // ever returns true, deploying signs out every dashboard user simultaneously.
  it("treats a pre-tokenVersion token (undefined) as current against the 0 default", () => {
    expect(isTokenRevoked(undefined, 0)).toBe(false);
  });

  it("still revokes a pre-tokenVersion token once the account has been bumped", () => {
    expect(isTokenRevoked(undefined, 1)).toBe(true);
  });

  // Guards the ?? fallback specifically: `||` would treat a legitimate version 0 as missing. Same
  // result here, but the test documents which operator is required.
  it("treats an explicit version 0 as current", () => {
    expect(isTokenRevoked(0, 0)).toBe(false);
  });
});
