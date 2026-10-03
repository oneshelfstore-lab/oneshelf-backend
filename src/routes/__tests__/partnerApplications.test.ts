import { describe, expect, it, vi, beforeEach } from "vitest";

// Pins the "Partner with us" lead rules (field validation) and what approving a seller lead does to an
// existing account — the riskiest bit: it can flip a customer's role to SELLER, and re-open a REJECTED seller.

const h = vi.hoisted(() => {
  const tx = {
    user: { update: vi.fn(async (a: any) => ({ id: a.where.id })), create: vi.fn(async (_a?: any) => ({ id: "new-user" })), findUnique: vi.fn(async () => null) },
    seller: { create: vi.fn(async (_a?: any) => ({})) },
  };
  return {
    tx,
    user: { findFirst: vi.fn(async (_a?: any): Promise<any> => null) },
    seller: { findUnique: vi.fn(async () => null), update: vi.fn(async (_a?: any) => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
});
vi.mock("../../lib/prisma.js", () => ({ default: h }));
vi.mock("../../middleware/firebaseAuth.js", () => ({
  firebaseAuthMiddleware: (_q: any, _s: any, next: any) => next(),
  requireAppRole: () => (_q: any, _s: any, next: any) => next(),
}));
vi.mock("../../services/fcmNotifier.js", () => ({ notifyPartnerApproved: vi.fn(), notifyPartnerRejected: vi.fn() }));

import { applicationSchema } from "../partnerApplications.js";
import { sellerSetupFromLead } from "../../data/shopTypes.js";
import { provisionSeller } from "../ownerPartnerApplications.js";

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function withCheck(first14: string) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return first14 + CHARS[(36 - (sum % 36)) % 36]!;
}
const GOOD_GSTIN = withCheck("09ABCDE1234F2Z");

const base = { businessName: "Sharma General Store", contactName: "Rohan Sharma" };
const firstMessage = (input: object) => {
  const r = applicationSchema.safeParse({ ...base, ...input });
  return r.success ? null : r.error.errors[0]!.message;
};

describe("applicationSchema", () => {
  it("accepts a plain application and ignores any phone in the body (the token supplies it)", () => {
    const r = applicationSchema.safeParse({ ...base, phone: "1234567890" });
    expect(r.success).toBe(true);
    expect(r.success && "phone" in r.data).toBe(false);
  });

  it("rejects emoji / digits in a person's name and emoji in a shop name", () => {
    expect(firstMessage({ contactName: "Rohan 😀" })).toMatch(/letters/);
    expect(firstMessage({ contactName: "Rohan123" })).toMatch(/letters/);
    expect(firstMessage({ businessName: "Shop 😀" })).toMatch(/characters/);
    expect(firstMessage({ businessName: "Sharma & Sons (Bijnor) 24/7" })).toBeNull();
  });

  it("gives a readable message for a bad email, an over-long name and spaces-only", () => {
    expect(firstMessage({ email: "not-an-email" })).toMatch(/valid email/);
    expect(firstMessage({ contactName: "a".repeat(121) })).toMatch(/too long/);
    expect(firstMessage({ contactName: "   " })).toMatch(/Enter your name/);
  });

  it("normalises a pasted GSTIN (spaces, lowercase) and rejects a bad one with the reason", () => {
    const pasted = ` ${GOOD_GSTIN.slice(0, 5).toLowerCase()} ${GOOD_GSTIN.slice(5)} `;
    const ok = applicationSchema.safeParse({ ...base, gstin: pasted });
    expect(ok.success && ok.data.gstin).toBe(GOOD_GSTIN);
    expect(firstMessage({ gstin: GOOD_GSTIN.slice(0, 14) + "0" })).toMatch(/checksum/);
    expect(firstMessage({ gstin: "22AAAAA" })).toMatch(/15 characters/);
    expect(firstMessage({ gstin: "" })).toBeNull(); // optional
  });
});

describe("provisionSeller", () => {
  const lead = { kind: "SELLER", businessName: "Sharma General Store", contactName: "Rohan Sharma", phone: "9876543210", email: null, gstin: null, category: "Grocery & Food" };
  beforeEach(() => vi.clearAllMocks());

  it("creates a login + a stub PENDING / NOT_STARTED seller for a brand-new phone", async () => {
    const id = await provisionSeller(lead);
    expect(id).toBe("new-user");
    expect(h.tx.user.create.mock.calls[0]![0].data).toMatchObject({ role: "SELLER", phone: "9876543210" });
    expect(h.tx.seller.create.mock.calls[0]![0].data).toMatchObject({ status: "PENDING", onboardingStatus: "NOT_STARTED", ownerUserId: "new-user" });
  });

  it("promotes an existing customer's account instead of creating a second user", async () => {
    h.user.findFirst.mockResolvedValueOnce({ id: "cust1", name: "Rohan S", email: null, sellerAccount: null });
    expect(await provisionSeller(lead)).toBe("cust1");
    expect(h.tx.user.create).not.toHaveBeenCalled();
    expect(h.tx.user.update.mock.calls[0]![0].data).toMatchObject({ role: "SELLER" });
  });

  it("re-opens a REJECTED seller (keeps their data, clears the stale reason)", async () => {
    h.user.findFirst.mockResolvedValueOnce({ id: "u2", sellerAccount: { id: "s2", onboardingStatus: "REJECTED" } });
    expect(await provisionSeller(lead)).toBe("u2");
    expect(h.seller.update.mock.calls[0]![0]).toMatchObject({ where: { id: "s2" }, data: { onboardingStatus: "IN_PROGRESS", onboardingRejectionReason: null } });
  });

  it("does nothing for someone who is already a live seller", async () => {
    h.user.findFirst.mockResolvedValueOnce({ id: "u3", sellerAccount: { id: "s3", onboardingStatus: "APPROVED" } });
    expect(await provisionSeller(lead)).toBeNull();
    expect(h.seller.update).not.toHaveBeenCalled();
    expect(h.tx.seller.create).not.toHaveBeenCalled();
  });
});

describe("restaurant leads", () => {
  const lead = { kind: "RESTAURANT", businessName: "Sharma Sweets", contactName: "Rohan Sharma", phone: "9876543210", email: null, gstin: null, category: "SWEET_SHOP" };
  beforeEach(() => vi.clearAllMocks());

  it("accepts the RESTAURANT kind", () => {
    expect(applicationSchema.safeParse({ ...base, kind: "RESTAURANT" }).success).toBe(true);
  });

  it("provisions a kitchen: chosen kitchen type + vertical FOOD (the old Food lead left vertical SHOP)", async () => {
    await provisionSeller(lead);
    expect(h.tx.seller.create.mock.calls[0]![0].data).toMatchObject({ shopType: "SWEET_SHOP", alsoSellCategories: [], vertical: "FOOD" });
  });

  it("maps the setup: unknown kitchen type → restaurant; a legacy shop lead that ticked Food → FOOD; shop → SHOP", () => {
    expect(sellerSetupFromLead("RESTAURANT", "Café")).toMatchObject({ shopType: "CAFE", vertical: "FOOD" });
    expect(sellerSetupFromLead("RESTAURANT", "nonsense")).toMatchObject({ shopType: "RESTAURANT", vertical: "FOOD" });
    expect(sellerSetupFromLead("SELLER", "Food")).toMatchObject({ shopType: "RESTAURANT", vertical: "FOOD" });
    expect(sellerSetupFromLead("SELLER", "Grocery & Food,Fresh & Dairy")).toMatchObject({ shopType: "GENERAL_STORE", alsoSell: ["FRUIT_VEG"], vertical: "SHOP" });
    expect(sellerSetupFromLead("SELLER", "")).toBeNull();
  });
});
