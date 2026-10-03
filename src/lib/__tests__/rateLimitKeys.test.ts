import { describe, expect, it } from "vitest";
import { bearerBucket } from "../rateLimitKeys.js";

describe("bearerBucket", () => {
  it("gives each token its own stable bucket and never contains the raw token", () => {
    const a = bearerBucket("Bearer abc.def.ghi");
    expect(a).toBe(bearerBucket("Bearer abc.def.ghi"));
    expect(a).not.toBe(bearerBucket("Bearer other.token"));
    expect(a).not.toContain("abc");
  });
  it("returns null (IP buckets apply) when there is no usable bearer token", () => {
    expect(bearerBucket(undefined)).toBeNull();
    expect(bearerBucket("")).toBeNull();
    expect(bearerBucket("Basic xyz")).toBeNull();
    expect(bearerBucket("Bearer   ")).toBeNull();
  });
});
