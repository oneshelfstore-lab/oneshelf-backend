// The 16 super-categories every product lives under (the Home tabs, the registration pick list, and the first step of the
// seller's add-product picker). Registration offers these same names (DEPARTMENT_REP in shopTypes.ts); the legacy
// `departments` column below is NO LONGER READ — the seller picker matches on the super's NAME. Applied by scripts/restructureSupers.ts; edit here or via the owner super-category PUT.
//
// Deliberate gaps: "Bakery & sweets" has no super (it gets its own section in the food interface); "Food"
// (restaurants) runs on a menu. Festivals (Diwali…) are COLLECTIONS the admin fills, never supers or categories.

export const SUPER_CATEGORIES: { slug: string; name: string; departments: string[] }[] = [
  { slug: "grocery_food", name: "Grocery & Food", departments: ["Grocery"] },
  { slug: "fresh_dairy", name: "Fresh & Dairy", departments: ["Fresh"] },
  { slug: "personal_care_beauty", name: "Personal Care & Beauty", departments: ["Beauty"] },
  { slug: "health_wellness", name: "Health & Wellness", departments: ["Health"] },
  { slug: "home_kitchen", name: "Home & Kitchen", departments: ["Home", "Garden"] },
  { slug: "cleaning_household", name: "Cleaning & Household", departments: ["Home", "Grocery"] },
  { slug: "electronics_accessories", name: "Electronics & Accessories", departments: ["Electronics"] },
  { slug: "stationery_office", name: "Stationery & Office", departments: ["Books & stationery"] },
  { slug: "books_education", name: "Books & Education", departments: ["Books & stationery"] },
  { slug: "baby_kids", name: "Baby & Kids", departments: ["Baby & kids"] },
  { slug: "toys_games", name: "Toys & Games", departments: ["Toys & gifts"] },
  { slug: "sports_fitness", name: "Sports & Fitness", departments: ["Sports"] },
  { slug: "automotive", name: "Automotive", departments: ["Automotive"] },
  { slug: "hardware_electrical", name: "Hardware & Electrical", departments: ["Hardware"] },
  { slug: "pet_supplies", name: "Pet Supplies", departments: ["Pet"] },
  { slug: "gifts_lifestyle", name: "Gifts & Lifestyle", departments: ["Toys & gifts", "Jewellery"] },
];

/** Super-categories dropped on purpose (Oct 3 2026: no fashion/footwear in the catalogue). Deleted by restructureSupers.ts when empty. */
export const DELETED_SUPERS = ["fashion_clothing", "footwear_accessories"];

/** Old super-categories replaced by the list above. Deactivated (never deleted) so the change is reversible. */
export const RETIRED_SUPERS = [
  "grocery", "grocery_kitchen", "snacks_drinks", "household_care", "fresh_and_dairy", "electronics",
  "stationery_school_writing", "stationery_art_craft", "stationery_office_business", "stationery_gifts_learning",
  "diwali",
];

export const STATIONERY_SUPER = "stationery_office";
export const DEFAULT_SUPER = "grocery_food"; // every non-stationery root that isn't seasonal
