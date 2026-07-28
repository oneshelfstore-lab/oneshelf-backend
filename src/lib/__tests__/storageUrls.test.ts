import { describe, it, expect } from "vitest";
import { classifyStoredMedia } from "../storageUrls.js";

/**
 * Pins the routing decision behind order-media signed URLs. Both silent failure modes live here:
 *
 *  1. A LEGACY row (full https download URL, written before the switch to stored paths) getting
 *     classified as "sign" — we'd hand its whole URL to `bucket.file()` as if it were an object
 *     path, get a signing error, return null, and every pre-change order would silently lose its
 *     gate photo / voice note with no backfill having been run.
 *  2. A NEW row (bare object path) getting classified as "passthrough" — the app would receive
 *     `order_gate_photos/uid/123.jpg`, Coil would fail to load it, and the photo would just be
 *     missing with nothing in the logs.
 *
 * Neither throws, which is exactly why they need a test rather than a stack trace.
 */
describe("classifyStoredMedia", () => {
  it("signs a bare Storage object path (the post-change upload shape)", () => {
    expect(classifyStoredMedia("order_gate_photos/abc123/1712345678.jpg")).toBe("sign");
    expect(classifyStoredMedia("order_voice_notes/abc123/1712345678.m4a")).toBe("sign");
    expect(classifyStoredMedia("delivery_proof_photos/rider9/1712345678.jpg")).toBe("sign");
  });

  it("passes a legacy permanent download URL through untouched — no backfill needed", () => {
    const legacy =
      "https://firebasestorage.googleapis.com/v0/b/kirana-store-d3c06.appspot.com/o/" +
      "order_gate_photos%2Fabc%2F1.jpg?alt=media&token=deadbeef-1234";
    expect(classifyStoredMedia(legacy)).toBe("passthrough");
  });

  it("passes local mock/offline URIs through (the app echoes these when signed out)", () => {
    expect(classifyStoredMedia("file:///data/user/0/com.kiranastore.app/cache/x.jpg")).toBe("passthrough");
    expect(classifyStoredMedia("content://media/external/images/media/42")).toBe("passthrough");
    expect(classifyStoredMedia("http://example.test/legacy.jpg")).toBe("passthrough");
  });

  it("treats null / undefined / blank as nothing to serve", () => {
    expect(classifyStoredMedia(null)).toBe("empty");
    expect(classifyStoredMedia(undefined)).toBe("empty");
    expect(classifyStoredMedia("")).toBe("empty");
    expect(classifyStoredMedia("   ")).toBe("empty");
  });

  it("does not mistake a path containing 'http' further in for an absolute URL", () => {
    // A filename can legitimately contain the substring — only a real scheme PREFIX is a URL.
    expect(classifyStoredMedia("order_gate_photos/uid/https-screenshot.jpg")).toBe("sign");
  });
});
