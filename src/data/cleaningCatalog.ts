// Cleaning & Household: 11 categories → children → grandchildren, as supplied, plus light per-category product
// fields. Loaded by scripts/seedTree.ts (see data/catalogTrees.ts).
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const fragrance = t("fragrance", "Fragrance", { showOnCard: true });
const packCount = num("pack_count", "Pieces in pack", { showOnCard: true });
const bagSize = pick("bag_size", "Size", ["Small", "Medium", "Large", "XL"], { filterable: true, showOnCard: true });

export const CLEANING: Root[] = [
  {
    n: "Laundry Care", f: [fragrance],
    k: [
      { ...k("Detergents", "Detergent Powder", "Liquid Detergent", "Detergent Pods", "Detergent Bar"), f: [pick("suitable_for", "Suitable for", ["Top load", "Front load", "Hand wash", "All"], { filterable: true, showOnCard: true })] },
      k("Fabric Care", "Fabric Softener", "Fabric Conditioner", "Laundry Starch", "Fabric Freshener"),
      k("Stain & Specialty Care", "Stain Remover", "Bleach", "Color Protector", "Laundry Whitener"),
    ],
  },
  {
    n: "Surface & Floor Cleaning", f: [fragrance],
    k: [
      k("Floor Cleaners", "Floor Cleaner", "Disinfectant Floor Cleaner", "Phenyl"),
      k("Surface Cleaners", "Multipurpose Cleaner", "Kitchen Surface Cleaner", "Furniture Cleaner", "Disinfectant Spray"),
      k("Glass & Window Cleaners", "Glass Cleaner", "Window Cleaner"),
      k("Specialty Cleaners", "Marble Cleaner", "Wood Cleaner", "Metal Cleaner", "Stainless Steel Cleaner"),
    ],
  },
  {
    n: "Bathroom & Toilet Cleaning", f: [fragrance],
    k: [
      k("Toilet Cleaners", "Toilet Cleaner", "Toilet Cleaning Gel", "Toilet Blocks"),
      k("Bathroom Cleaners", "Bathroom Cleaner", "Tile Cleaner", "Grout Cleaner", "Limescale Remover"),
      k("Drain Care", "Drain Cleaner", "Drain Opener", "Drain Freshener"),
    ],
  },
  {
    n: "Dishwashing", f: [fragrance],
    k: [
      k("Dishwashing Products", "Dishwash Liquid", "Dishwash Gel", "Dishwash Bar", "Dishwasher Tablets"),
      { ...k("Dishwashing Accessories", "Scrubber", "Sponge", "Dish Brush", "Steel Wool", "Scrub Pad"), f: [packCount] },
    ],
  },
  {
    n: "Cleaning Tools",
    k: [
      { ...k("Brooms", "Grass Broom", "Plastic Broom", "Soft Broom", "Hard Broom"), f: [t("colour", "Colour")] },
      k("Mops", "Floor Mop", "Spin Mop", "Spray Mop", "Flat Mop"),
      k("Brushes", "Floor Brush", "Toilet Brush", "Scrub Brush", "Bottle Brush", "Cleaning Brush"),
      k("Dusting", "Duster", "Microfiber Duster", "Feather Duster", "Dustpan"),
      k("Cleaning Accessories", "Squeegee", "Cleaning Gloves", "Microfiber Cloth", "Cleaning Cloth", "Spray Bottle"),
    ],
  },
  {
    n: "Garbage & Waste Management",
    k: [
      { ...k("Garbage Bags", "Small Garbage Bag", "Medium Garbage Bag", "Large Garbage Bag", "Biodegradable Garbage Bag"), f: [bagSize, packCount, yn("biodegradable", "Biodegradable", { filterable: true })] },
      { ...k("Waste Bins", "Dustbin", "Pedal Bin", "Swing Bin", "Garbage Bin"), f: [num("capacity", "Capacity", { unit: "L", filterable: true, showOnCard: true }), t("colour", "Colour")] },
      k("Waste Accessories", "Bin Liners", "Waste Bags", "Waste Sorting Bags"),
    ],
  },
  {
    n: "Pest Control", f: [yn("refill_included", "Refill / machine included")],
    k: [
      k("Mosquito Control", "Mosquito Coil", "Liquid Vaporizer", "Mosquito Mat", "Mosquito Repellent"),
      k("Cockroach & Ant Control", "Cockroach Spray", "Cockroach Bait", "Ant Killer", "Insect Killer"),
      k("Fly Control", "Fly Paper", "Fly Trap", "Fly Repellent"),
      k("Rodent Control", "Rat Trap", "Mouse Trap", "Rodent Repellent"),
    ],
  },
  {
    n: "Air & Home Fresheners", f: [fragrance],
    k: [
      k("Air Fresheners", "Room Spray", "Gel Air Freshener", "Automatic Air Freshener", "Hanging Air Freshener"),
      k("Fragrance", "Room Fragrance", "Fragrance Diffuser", "Fragrance Sachet"),
      k("Odor Control", "Odor Eliminator", "Shoe Deodorizer"),
    ],
  },
  {
    n: "Paper & Tissue Products", f: [num("ply", "Ply", { filterable: true }), packCount],
    k: [
      k("Tissues", "Facial Tissue", "Toilet Tissue", "Kitchen Tissue", "Pocket Tissue"),
      k("Napkins", "Paper Napkin", "Table Napkin"),
      k("Paper Towels", "Kitchen Paper Towel", "Household Paper Towel"),
    ],
  },
  {
    n: "Disposable Household Products", f: [packCount],
    k: [
      k("Food & Utility Bags", "Zip Lock Bag", "Storage Bag", "Disposable Bag"),
      k("Disposable Tableware", "Paper Plate", "Paper Cup", "Disposable Cup", "Disposable Spoon", "Disposable Container"),
      { ...k("Food Wrapping", "Aluminium Foil", "Cling Film", "Butter Paper", "Baking Paper"), f: [num("length", "Length", { unit: "m", showOnCard: true })] },
    ],
  },
  {
    n: "Household Utility",
    k: [
      k("Clothes Care", "Cloth Clips", "Laundry Bag", "Lint Roller"),
      k("Household Consumables", "Matchbox", "Lighter", "Batteries", "Light Bulb"),
      k("Miscellaneous", "Rubber Gloves", "Utility Rope", "Sewing Kit", "Household Tape"),
    ],
  },
];

type Move = { name?: string; subcategory?: string; from: string; path: string[] };
const hp = (m: Omit<Move, "from">): Move => ({ from: "household_personal", ...m });
const ik = (m: Omit<Move, "from">): Move => ({ from: "insect_killer", ...m });

/**
 * Existing products that belong in this tree. Order matters: name matches first, then the subcategory catch-alls
 * (a moved product has left its old root, so a later catch-all never sees it). Not moved: unlabeled demo products,
 * "Kaveri Mehandi" (henna → Personal Care), "Rubber Band Packet" (→ Stationery), the two agarbatti and the mouse pad
 * in insect_killer (no home in this tree).
 */
export const CLEANING_MOVES: Move[] = [
  // Laundry
  hp({ name: "Comfort Liquid", path: ["Laundry Care", "Fabric Care", "Fabric Conditioner"] }),
  hp({ subcategory: "Laundry Soap", path: ["Laundry Care", "Detergents", "Detergent Bar"] }),
  hp({ subcategory: "Cleaning & Detergents", path: ["Laundry Care", "Detergents", "Detergent Powder"] }),
  hp({ name: "Surf Excel Detergent", path: ["Laundry Care", "Detergents", "Detergent Powder"] }),
  hp({ name: "Ariel", path: ["Laundry Care", "Detergents"] }),
  hp({ subcategory: "Washing powder & liquid", path: ["Laundry Care", "Detergents"] }),
  // Cleaners
  hp({ name: "Doctor Brand Phenyle", path: ["Surface & Floor Cleaning", "Floor Cleaners", "Phenyl"] }),
  hp({ name: "5L Phenyle", path: ["Surface & Floor Cleaning", "Floor Cleaners", "Phenyl"] }),
  hp({ name: "Lizol", path: ["Surface & Floor Cleaning", "Floor Cleaners", "Disinfectant Floor Cleaner"] }),
  hp({ name: "Colin", path: ["Surface & Floor Cleaning", "Glass & Window Cleaners", "Glass Cleaner"] }),
  hp({ name: "Harpic Red", path: ["Bathroom & Toilet Cleaning", "Toilet Cleaners", "Toilet Cleaner"] }),
  hp({ name: "Harpic Blue", path: ["Bathroom & Toilet Cleaning", "Toilet Cleaners", "Toilet Cleaner"] }),
  // Dishwashing
  hp({ name: "Xpert Bar", path: ["Dishwashing", "Dishwashing Products", "Dishwash Bar"] }),
  hp({ name: "Patanjali Dishwash Bar", path: ["Dishwashing", "Dishwashing Products", "Dishwash Bar"] }),
  hp({ name: "Vim Bar", path: ["Dishwashing", "Dishwashing Products", "Dishwash Bar"] }),
  hp({ name: "Vim Gel", path: ["Dishwashing", "Dishwashing Products", "Dishwash Gel"] }),
  hp({ subcategory: "Dishwash", path: ["Dishwashing", "Dishwashing Products"] }),
  hp({ name: "Cleaning Pad", path: ["Dishwashing", "Dishwashing Accessories", "Scrub Pad"] }),
  hp({ name: "Green Cleaning Pad", path: ["Dishwashing", "Dishwashing Accessories", "Scrub Pad"] }),
  hp({ name: "Steel Scrubber", path: ["Dishwashing", "Dishwashing Accessories", "Scrubber"] }),
  hp({ name: "Xpert Steel Scrubber", path: ["Dishwashing", "Dishwashing Accessories", "Scrubber"] }),
  // Tools, fresheners, paper, utility
  hp({ name: "Broom", path: ["Cleaning Tools", "Brooms"] }),
  hp({ subcategory: "Room freshners", path: ["Air & Home Fresheners", "Air Fresheners"] }),
  hp({ name: "Paper Roll", path: ["Paper & Tissue Products", "Paper Towels"] }),
  hp({ name: "Match Box Lakdi", path: ["Household Utility", "Household Consumables", "Matchbox"] }),
  hp({ name: "Match Box Wax", path: ["Household Utility", "Household Consumables", "Matchbox"] }),
  hp({ name: "Household Match Box", path: ["Household Utility", "Household Consumables", "Matchbox"] }),
  hp({ subcategory: "Batteries", path: ["Household Utility", "Household Consumables", "Batteries"] }),
  // Pest control (the old insect_killer root)
  ik({ name: "Good Knight Coil Red", path: ["Pest Control", "Mosquito Control", "Mosquito Coil"] }),
  ik({ name: "Good Knight Coil Black", path: ["Pest Control", "Mosquito Control", "Mosquito Coil"] }),
  ik({ name: "Good knight refill", path: ["Pest Control", "Mosquito Control", "Liquid Vaporizer"] }),
  ik({ name: "Good Knight Machine+Refill", path: ["Pest Control", "Mosquito Control", "Liquid Vaporizer"] }),
  ik({ name: "All out Machine+Refill", path: ["Pest Control", "Mosquito Control", "Liquid Vaporizer"] }),
  ik({ name: "All out Refill", path: ["Pest Control", "Mosquito Control", "Liquid Vaporizer"] }),
  ik({ name: "Odomos", path: ["Pest Control", "Mosquito Control", "Mosquito Repellent"] }),
  ik({ name: "Hit Red", path: ["Pest Control", "Cockroach & Ant Control", "Insect Killer"] }),
  ik({ name: "Hit Black", path: ["Pest Control", "Cockroach & Ant Control", "Insect Killer"] }),
  ik({ name: "Laxmanrekhaa chalk", path: ["Pest Control", "Cockroach & Ant Control", "Ant Killer"] }),
];
