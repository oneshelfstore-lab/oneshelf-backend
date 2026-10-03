// Registry of category trees scripts/seedTree.ts can load. To add the next department: write its data file,
// add one entry here (its super's slug comes from data/superCategories.ts), run seedTree.
import { STATIONERY } from "./stationeryCatalog.js";
import { FRESH_DAIRY, FRESH_DAIRY_MOVES } from "./freshDairyCatalog.js";
import { PERSONAL_CARE, PERSONAL_CARE_MOVES } from "./personalCareCatalog.js";
import { HOME_KITCHEN, HOME_KITCHEN_MOVES } from "./homeKitchenCatalog.js";
import type { Root } from "./stationeryCatalog.js";

export type TreeDef = {
  superSlug: string;
  /** Prefix for derived root slugs (a Root with its own `slug` keeps it). */
  prefix: string;
  roots: Root[];
  /** Products to re-file into the tree: matched by exact `name` or free-text `subcategory` within the `from` root. */
  moves?: { name?: string; subcategory?: string; from: string; path: string[] }[];
  /** Old root categories this tree replaces: deactivated (never deleted) once their products are moved. */
  retireRoots?: string[];
};

export const TREES: Record<string, TreeDef> = {
  stationery: { superSlug: "stationery_office", prefix: "stationery_", roots: STATIONERY.flatMap((g) => g.roots) },
  fresh_dairy: { superSlug: "fresh_dairy", prefix: "fresh_", roots: FRESH_DAIRY, moves: FRESH_DAIRY_MOVES, retireRoots: ["fresh"] },
  personal_care: { superSlug: "personal_care_beauty", prefix: "care_", roots: PERSONAL_CARE, moves: PERSONAL_CARE_MOVES, retireRoots: ["beauty"] },
  home_kitchen: { superSlug: "home_kitchen", prefix: "hk_", roots: HOME_KITCHEN, moves: HOME_KITCHEN_MOVES, retireRoots: ["crockery"] },
};
