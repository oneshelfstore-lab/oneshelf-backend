// Registry of category trees scripts/seedTree.ts can load. To add the next department: write its data file,
// add one entry here (its super's slug comes from data/superCategories.ts), run seedTree.
import { STATIONERY } from "./stationeryCatalog.js";
import { FRESH_DAIRY, FRESH_DAIRY_MOVES } from "./freshDairyCatalog.js";
import { PERSONAL_CARE, PERSONAL_CARE_MOVES } from "./personalCareCatalog.js";
import { HOME_KITCHEN, HOME_KITCHEN_MOVES } from "./homeKitchenCatalog.js";
import { CLEANING, CLEANING_MOVES } from "./cleaningCatalog.js";
import { HEALTH, HEALTH_MOVES } from "./healthCatalog.js";
import { BOOKS } from "./booksCatalog.js";
import { TOYS } from "./toysCatalog.js";
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
  cleaning: { superSlug: "cleaning_household", prefix: "cl_", roots: CLEANING, moves: CLEANING_MOVES, retireRoots: ["insect_killer"] },
  health: { superSlug: "health_wellness", prefix: "hw_", roots: HEALTH, moves: HEALTH_MOVES, retireRoots: ["herbs_ayurvedic_products"] },
  // Retires the stationery "Educational Products" root: charts, maps, globes and workbooks now live here.
  books: { superSlug: "books_education", prefix: "edu_", roots: BOOKS, retireRoots: ["stationery_educational_products"] },
  toys: { superSlug: "toys_games", prefix: "toy_", roots: TOYS },
};
