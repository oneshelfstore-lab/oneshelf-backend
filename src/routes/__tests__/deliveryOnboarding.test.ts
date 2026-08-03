import { describe, it, expect } from "vitest";
import { deliveryBankSchema } from "../deliveryOnboarding.js";

// This field was `z.any()` until now, so every case below used to pass silently. The failure mode
// is invisible at save time and only surfaces when someone tries to actually pay the rider — hence
// pinning it rather than trusting the regexes by eye.
describe("deliveryBankSchema", () => {
  const parse = (v: unknown) => deliveryBankSchema.safeParse(v);

  it("accepts a well-formed account + IFSC pair", () => {
    const r = parse({ accountNumber: "123456789012", ifsc: "HDFC0001234", upi: "" });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ accountNumber: "123456789012", ifsc: "HDFC0001234" });
  });

  it("upper-cases a lower-case IFSC instead of rejecting it", () => {
    // A rider pasting from a passbook photo/app types lower case; failing that would be an error
    // with no on-screen explanation.
    const r = parse({ accountNumber: "123456789012", ifsc: "hdfc0001234" });
    expect(r.success && r.data?.ifsc).toBe("HDFC0001234");
  });

  it("rejects a malformed IFSC", () => {
    // The old z.any() stored "asdf" happily.
    expect(parse({ accountNumber: "123456789012", ifsc: "asdf" }).success).toBe(false);
    // 5th char must be the reserved 0.
    expect(parse({ accountNumber: "123456789012", ifsc: "HDFC1001234" }).success).toBe(false);
  });

  it("rejects an account number that isn't 9-18 digits", () => {
    expect(parse({ accountNumber: "12345", ifsc: "HDFC0001234" }).success).toBe(false);
    expect(parse({ accountNumber: "12345678901234567890", ifsc: "HDFC0001234" }).success).toBe(false);
    expect(parse({ accountNumber: "12345678九", ifsc: "HDFC0001234" }).success).toBe(false);
  });

  it("rejects an account number without its IFSC, and vice versa", () => {
    // Either half alone is an account nobody can pay into.
    expect(parse({ accountNumber: "123456789012", ifsc: "" }).success).toBe(false);
    expect(parse({ accountNumber: "", ifsc: "HDFC0001234" }).success).toBe(false);
  });

  it("allows UPI on its own — a rider may settle by UPI with no bank account on file", () => {
    const r = parse({ accountNumber: "", ifsc: "", upi: "rider@okhdfcbank" });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ upi: "rider@okhdfcbank" });
  });

  it("rejects a malformed UPI ID", () => {
    expect(parse({ upi: "notaupiid" }).success).toBe(false);
    expect(parse({ upi: "@ybl" }).success).toBe(false);
  });

  it("treats an all-blank form as empty rather than malformed", () => {
    // The app always sends all three keys, blanking the ones left untouched — a half-filled
    // progressive save must not hard-fail.
    const r = parse({ accountNumber: "", ifsc: "", upi: "" });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({});
  });

  it("accepts null (clearing the field) and undefined (field absent from a partial save)", () => {
    expect(parse(null).success).toBe(true);
    expect(parse(undefined).success).toBe(true);
  });
});
