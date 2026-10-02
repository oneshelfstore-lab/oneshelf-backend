import { describe, expect, it } from "vitest";
import { stockCrossing } from "../stockLevel.js";

describe("stockCrossing", () => {
  it("alerts once, on the sale that takes stock to the line", () => {
    expect(stockCrossing(8, 5, 5)).toBe("LOW"); // lands exactly on the threshold
    expect(stockCrossing(7, 3, 5)).toBe("LOW");
  });

  it("stays quiet for every sale after that, and while stock is healthy", () => {
    expect(stockCrossing(5, 4, 5)).toBeNull(); // already low
    expect(stockCrossing(3, 2, 5)).toBeNull();
    expect(stockCrossing(20, 15, 5)).toBeNull();
  });

  it("says OUT when it runs dry, even straight from healthy", () => {
    expect(stockCrossing(2, 0, 5)).toBe("OUT");
    expect(stockCrossing(30, 0, 5)).toBe("OUT");
    expect(stockCrossing(0, 0, 5)).toBeNull(); // already out
  });

  it("threshold 0 means only tell me when it's gone", () => {
    expect(stockCrossing(3, 1, 0)).toBeNull();
    expect(stockCrossing(1, 0, 0)).toBe("OUT");
  });

  it("copes with loose (fractional) stock", () => {
    expect(stockCrossing(5.5, 4.75, 5)).toBe("LOW");
  });
});
