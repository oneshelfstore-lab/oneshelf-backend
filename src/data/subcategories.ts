// Canonical sub-categories per top-level category (keyed by category slug), ordered
// for display. Products store the chosen sub-category NAME in CatalogProduct.subcategory;
// GET /api/app/categories/:slug/subcategories returns these merged with live product
// counts. This tames the previously free-text `subcategory` into a consistent facet
// without a schema migration. Keep this in sync with the Android Subcategories.kt mirror.

export const SUBCATEGORIES: Record<string, string[]> = {
  staples_grains: [
    "Atta & Flours",
    "Rice",
    "Dals & Pulses",
    "Sugar & Jaggery",
    "Salt",
    "Sooji, Besan & Rava",
    "Poha & Other Grains",
  ],
  dairy: [
    "Milk",
    "Curd & Yogurt",
    "Paneer & Tofu",
    "Butter & Cheese",
    "Ghee",
    "Cream & Condensed Milk",
  ],
  oils_spices_masalas: [
    "Cooking Oils",
    "Ghee & Vanaspati",
    "Whole Spices",
    "Ground Spices",
    "Blended Masalas",
    "Salt, Sugar & Sweeteners",
  ],
  beverages: [
    "Tea",
    "Coffee",
    "Soft Drinks",
    "Juices & Mixes",
    "Health & Energy Drinks",
    "Water",
  ],
  snacks_namkeen: [
    "Chips & Wafers",
    "Namkeen & Mixtures",
    "Biscuits & Cookies",
    "Chocolates & Candy",
    "Dry Fruits & Nuts",
  ],
  packaged_canned: [
    "Noodles & Pasta",
    "Ready to Eat",
    "Sauces & Ketchup",
    "Pickles & Chutneys",
    "Jams & Spreads",
    "Canned & Packaged",
  ],
  bakery_breakfast: [
    "Bread & Buns",
    "Cereals & Flakes",
    "Oats & Muesli",
    "Rusk & Khari",
    "Honey & Spreads",
  ],
  household_personal: [
    "Cleaning & Detergents",
    "Dishwash",
    "Soaps & Body Wash",
    "Hair Care",
    "Oral Care",
    "Skin Care",
    "Sanitary & Hygiene",
    "Paper & Disposables",
  ],
};

/** Stable URL/key slug derived from a sub-category display name. */
export function slugifySub(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
