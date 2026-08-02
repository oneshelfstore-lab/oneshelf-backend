import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // middleware/auth.ts hard-fails at import time on a missing or weak JWT_SECRET — that guard is
    // itself a security control (a predictable secret lets anyone forge admin tokens), so it must
    // not be softened just to make tests importable. Tests don't load dotenv, so supply a throwaway
    // value here instead. Never a real secret: it only has to satisfy the >= 32 char length check.
    env: {
      JWT_SECRET: "test-only-jwt-secret-not-used-anywhere-real-0123456789",
    },
  },
});
