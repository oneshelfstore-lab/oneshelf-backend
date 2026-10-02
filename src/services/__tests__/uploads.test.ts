import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/firebase.js", () => ({ admin: {}, isFirebaseInitialized: () => false }));

import { sniffImage } from "../../routes/uploads.js";

const pad = (b: number[]) => Buffer.from([...b, ...new Array(16).fill(0)]);

describe("sniffImage", () => {
  it("recognises JPEG, PNG and WebP by their bytes", () => {
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg");
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mime).toBe("image/png");
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(8)]);
    expect(sniffImage(webp)?.ext).toBe("webp");
  });
  it("rejects anything else, including a script renamed to .jpg", () => {
    expect(sniffImage(Buffer.from("<script>alert(1)</script>".padEnd(32, " ")))).toBeNull();
    expect(sniffImage(Buffer.alloc(4))).toBeNull();
  });
});
