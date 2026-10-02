import { describe, it, expect } from "vitest";
import { buildCategoryForm, cleanAttributes, fieldsForCategory, fieldSchemaSchema, specsFor, type FieldDef } from "../categoryFields.js";

const fields: FieldDef[] = [
  { key: "tip", label: "Tip size", type: "CHOICE", options: ["0.5", "0.7"], unit: "mm", required: true },
  { key: "pages", label: "Pages", type: "NUMBER" },
  { key: "refill", label: "Refillable", type: "BOOLEAN" },
];

describe("cleanAttributes", () => {
  it("keeps valid values, drops blanks and unknown keys", () => {
    expect(cleanAttributes(fields, { tip: "0.5", pages: " ", stale: "x" })).toEqual({ tip: "0.5" });
  });
  it("rejects a missing required field, bad choice, bad number, bad boolean", () => {
    expect(() => cleanAttributes(fields, {})).toThrow(/Tip size is required/);
    expect(() => cleanAttributes(fields, { tip: "9" })).toThrow(/not one of the options/);
    expect(() => cleanAttributes(fields, { tip: "0.5", pages: "abc" })).toThrow(/must be a number/);
    expect(() => cleanAttributes(fields, { tip: "0.5", refill: "maybe" })).toThrow(/yes or no/);
  });
});

describe("specsFor", () => {
  it("appends units, shows booleans as Yes/No, skips unfilled", () => {
    expect(specsFor(fields, { tip: "0.5", refill: "false" })).toEqual([
      { label: "Tip size", value: "0.5 mm" },
      { label: "Refillable", value: "No" },
    ]);
  });
});

describe("fieldSchemaSchema", () => {
  it("rejects duplicate keys and CHOICE without options", () => {
    expect(fieldSchemaSchema.safeParse([fields[1], fields[1]]).success).toBe(false);
    expect(fieldSchemaSchema.safeParse([{ key: "a", label: "A", type: "CHOICE" }]).success).toBe(false);
  });
});

describe("fieldsForCategory", () => {
  const rows: Record<string, { parentId: string | null; fieldSchema: unknown }> = {
    pens: { parentId: null, fieldSchema: [fields[0], fields[2]] },
    gel: { parentId: "pens", fieldSchema: [{ key: "tip", label: "Nib", type: "TEXT" }, { key: "gel", label: "Gel type", type: "TEXT" }] },
  };
  const db = { category: { findUnique: async ({ where }: any) => rows[where.id] ?? null } } as any;
  it("inherits down the tree and lets a child override a key in place", async () => {
    const out = await fieldsForCategory(db, "gel");
    expect(out.map((f) => f.key)).toEqual(["tip", "refill", "gel"]);
    expect(out[0]!.label).toBe("Nib");
  });
});

describe("buildCategoryForm", () => {
  const r = (id: string, parentId: string | null, fieldSchema: unknown = null, displayOrder = 0) => ({ id, name: id, parentId, displayOrder, fieldSchema });
  const rows = [
    r("pens", null, [fields[0]]),
    r("markers", "pens", [fields[1]]),
    r("board", "markers", [fields[2]]),
    r("gel", "pens", null, 1),
    r("other", null, [fields[1]]),
  ];
  it("gives each node its full inherited fields and nests types", () => {
    const f = buildCategoryForm(rows, "pens");
    expect(f.fields.map((x) => x.key)).toEqual(["tip"]);
    expect(f.children.map((c) => c.id)).toEqual(["markers", "gel"]);
    expect(f.children[0]!.fields.map((x) => x.key)).toEqual(["tip", "pages"]);
    expect(f.children[0]!.types![0]!.fields.map((x) => x.key)).toEqual(["tip", "pages", "refill"]);
    expect(f.children[1]!.types).toBeUndefined();
  });
});
