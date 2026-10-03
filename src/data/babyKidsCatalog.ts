// Baby & Kids: 8 categories → children → grandchildren. Child essentials only — NO clothing, innerwear, sleepwear,
// ethnic wear or footwear (not sold), and no toys (Toys & Games). So the supplied "Baby Bathrobe" (Bathing) and
// "Training Pants" (Potty Training) are left out. Age group, size, material, capacity and safety certification are
// product FIELDS. Loaded by scripts/seedTree.ts.
//
// Overlaps with live trees, kept as supplied: Baby Wipes / Cotton Buds / Baby Towel / Nail Clipper vs Personal Care >
// Baby Personal Care; School Bags / Pencil Box / Lunch Box / ID Card Holder / Water Bottle vs Stationery > School
// Essentials and Home & Kitchen > Water & Beverage Storage; Baby Monitor / Night Light are consumer electronics-adjacent.
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const age = pick("age_group", "Age group", ["0-6 months", "6-12 months", "1-3 years", "3-6 years", "6+ years", "All ages"], { filterable: true, showOnCard: true });
const material = (...o: string[]) => pick("material", "Material", o, { filterable: true, showOnCard: true });
const colour = t("colour", "Colour", { filterable: true });
const warranty = t("warranty", "Warranty", { showOnCard: true });
const bpaFree = yn("bpa_free", "BPA free", { filterable: true });
const packCount = num("pack_count", "Pieces in pack", { showOnCard: true });

export const BABY_KIDS: Root[] = [
  {
    n: "Baby Feeding", f: [age, material("Plastic", "Silicone", "Glass", "Stainless steel"), bpaFree],
    k: [
      { ...k("Feeding Bottles", "Baby Bottle", "Anti-Colic Bottle", "Wide Neck Bottle", "Bottle Set"), f: [num("capacity", "Capacity", { unit: "ml", filterable: true, showOnCard: true })] },
      k("Feeding Accessories", "Bottle Nipple", "Bottle Brush", "Bottle Sterilizer", "Bottle Warmer"),
      k("Baby Tableware", "Baby Bowl", "Baby Plate", "Baby Spoon", "Baby Feeding Set"),
      k("Breastfeeding", "Breast Pump", "Nursing Bottle", "Nursing Cover", "Milk Storage Bag"),
    ],
  },
  {
    n: "Diapering & Potty",
    k: [
      { ...k("Diapers", "Baby Diaper", "Pants Diaper", "Cloth Diaper"), f: [pick("diaper_size", "Size", ["New Born", "S", "M", "L", "XL", "XXL"], { filterable: true, showOnCard: true }), num("count", "Diapers in pack", { showOnCard: true }), t("weight_range", "Baby weight", { showOnCard: true })] },
      k("Diaper Accessories", "Diaper Changing Mat", "Diaper Caddy", "Diaper Disposal Bag", "Changing Pad"),
      k("Potty Training", "Baby Potty", "Potty Seat"),
    ],
  },
  {
    n: "Baby Care", f: [age],
    k: [
      k("Bathing", "Baby Bath Tub", "Baby Bath Seat", "Baby Towel"),
      k("Grooming", "Baby Comb", "Baby Hair Brush", "Baby Nail Clipper", "Baby Grooming Set"),
      { ...k("Hygiene Accessories", "Baby Wipes", "Baby Cotton Buds", "Baby Cotton Pads", "Changing Accessories"), f: [packCount] },
    ],
  },
  {
    n: "Baby Gear", f: [age, colour, warranty, yn("foldable", "Foldable", { filterable: true }), num("max_weight", "Max baby weight", { unit: "kg" })],
    k: [
      k("Strollers & Prams", "Baby Stroller", "Baby Pram", "Travel Stroller", "Double Stroller"),
      k("Baby Carriers", "Baby Carrier", "Baby Sling", "Hip Seat Carrier"),
      k("Baby Travel", "Travel Cot", "Baby Travel Bed", "Diaper Bag"),
      k("Baby Furniture", "Baby Cot", "Baby Crib", "Baby High Chair", "Baby Rocking Chair"),
    ],
  },
  {
    n: "Nursery & Bedding", f: [age, colour],
    k: [
      { ...k("Baby Bedding", "Baby Bedsheet", "Baby Blanket", "Baby Pillow", "Baby Mattress"), f: [material("Cotton", "Muslin", "Fleece", "Foam", "Coir"), t("size", "Size", { showOnCard: true })] },
      k("Nursery Accessories", "Baby Mosquito Net", "Nursery Organizer", "Baby Storage Basket", "Crib Accessories"),
      k("Sleep Accessories", "Baby Sleeping Bag", "Baby Sleep Positioner", "Baby Night Light"),
    ],
  },
  {
    n: "Baby & Child Safety", f: [age, yn("certified", "Safety certified", { filterable: true })],
    k: [
      k("Home Safety", "Safety Gate", "Socket Cover", "Drawer Lock", "Cabinet Lock", "Corner Guard"),
      { ...k("Travel Safety", "Child Car Seat", "Booster Seat", "Kids Safety Harness"), f: [t("weight_group", "Weight group", { filterable: true, showOnCard: true })] },
      k("Safety Accessories", "Baby Monitor", "Bed Rail", "Window Safety Lock"),
    ],
  },
  {
    n: "Kids School Essentials", f: [age, colour],
    k: [
      { ...k("School Bags", "Kids Backpack", "School Bag", "Lunch Bag"), f: [num("capacity", "Capacity", { unit: "L", filterable: true, showOnCard: true })] },
      k("School Accessories", "Pencil Box", "Kids Water Bottle", "Lunch Box", "ID Card Holder"),
      k("Study Accessories", "Kids Study Kit", "Homework Folder", "Study Organizer"),
    ],
  },
  {
    n: "Kids Travel & Utility", f: [age, colour],
    k: [
      k("Travel Accessories", "Kids Luggage", "Travel Pillow", "Travel Organizer"),
      k("Outdoor Accessories", "Kids Picnic Set", "Outdoor Mat", "Sun Protection Accessory"),
      k("Everyday Utility", "Kids Umbrella", "Kids Name Label", "Kids Storage Organizer"),
    ],
  },
];

/** The existing silicone nipple (old baby_care root) belongs with feeding accessories. */
export const BABY_KIDS_MOVES: { name?: string; subcategory?: string; from: string; path: string[] }[] = [
  { name: "Bonne Silicon NippLe", from: "baby_care", path: ["Baby Feeding", "Feeding Accessories", "Bottle Nipple"] },
];
