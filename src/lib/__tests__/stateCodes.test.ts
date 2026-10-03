import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({ default: {} }));

import { intraStateCheck, stateCodeFromName } from "../stateCodes.js";

// GSTINs only need the 2-digit state prefix here (09 = Uttar Pradesh, 27 = Maharashtra).
const UP_GSTIN = "09ABCDE1234F1Z5";

describe("stateCodeFromName", () => {
  it("reads normal, mis-cased, & / and, and old state names", () => {
    expect(stateCodeFromName("Uttar Pradesh")).toBe("09");
    expect(stateCodeFromName("  uttar  pradesh ")).toBe("09");
    expect(stateCodeFromName("Jammu & Kashmir")).toBe("01");
    expect(stateCodeFromName("Orissa")).toBe("21");
    expect(stateCodeFromName("UP")).toBeNull(); // abbreviations aren't guessed
    expect(stateCodeFromName(null)).toBeNull();
  });
});

describe("intraStateCheck", () => {
  it("SAME / DIFFERENT when both states resolve", () => {
    expect(intraStateCheck(UP_GSTIN, "Uttar Pradesh")).toBe("SAME");
    expect(intraStateCheck(UP_GSTIN, "Maharashtra")).toBe("DIFFERENT");
  });
  it("UNKNOWN — never a guess — when either side is missing or unrecognised", () => {
    expect(intraStateCheck(UP_GSTIN, null)).toBe("UNKNOWN");
    expect(intraStateCheck(UP_GSTIN, "Atlantis")).toBe("UNKNOWN");
    expect(intraStateCheck(null, "Uttar Pradesh")).toBe("UNKNOWN");
    expect(intraStateCheck("XX123", "Uttar Pradesh")).toBe("UNKNOWN"); // no fallback to the store's default state
  });
});
