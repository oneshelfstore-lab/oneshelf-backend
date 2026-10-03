// Fresh & Dairy: Dairy, Eggs, Fruits, Vegetables, Fresh Herbs, Cut & Pre-Cut, Fresh Bakery.
// Category (root) → child → grandchild, plus the product-form fields each level adds. Loaded by scripts/seedTree.ts.
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t, yn } from "./stationeryCatalog.js";

const organic = yn("organic", "Organic", { filterable: true });
const origin = t("origin", "Origin");
const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });

export const FRESH_DAIRY: Root[] = [
  {
    n: "Dairy", slug: "dairy", // the existing root (keeps its products)
    f: [organic, pick("storage", "Storage", ["Refrigerate", "Room temperature"])],
    k: [
      k("Milk", "Full Cream Milk", "Toned Milk", "Double Toned Milk", "Cow Milk", "Buffalo Milk", "A2 Milk", "Organic Milk", "UHT Milk", "Lactose-Free Milk", "Plant-Based Milk"),
      k("Curd & Yogurt", "Plain Curd", "Set Curd", "Greek Yogurt", "Flavoured Yogurt", "Probiotic Yogurt", "Buttermilk"),
      k("Paneer & Tofu", "Fresh Paneer", "Malai Paneer", "Low-Fat Paneer", "Tofu", "Flavoured Tofu"),
      k("Cheese", "Cheese Slices", "Cheese Blocks", "Cheese Cubes", "Cheese Spread", "Mozzarella", "Cream Cheese"),
      k("Butter & Margarine", "Salted Butter", "Unsalted Butter", "White Butter", "Margarine"),
      k("Ghee", "Cow Ghee", "Buffalo Ghee", "A2 Ghee", "Organic Ghee", "Bilona Ghee"),
      k("Cream", "Fresh Cream", "Whipping Cream", "Cooking Cream", "Sour Cream"),
    ],
  },
  {
    n: "Eggs",
    f: [num("egg_count", "Eggs in pack", { showOnCard: true, filterable: true }), pick("egg_size", "Size", ["Small", "Medium", "Large"], { filterable: true })],
    k: [
      k("Chicken Eggs", "White Eggs", "Brown Eggs", "Country Eggs", "Free-Range Eggs", "Organic Eggs", "Omega-3 Eggs"),
      k("Other Eggs", "Quail Eggs"),
    ],
  },
  {
    n: "Fruits", f: [organic, origin],
    k: [
      k("Apples", "Red Apple", "Green Apple", "Gala Apple", "Imported Apple"),
      k("Bananas", "Robusta", "Cavendish", "Elaichi Banana", "Nendran"),
      k("Citrus Fruits", "Orange", "Mosambi", "Lemon", "Grapefruit"),
      k("Melons", "Watermelon", "Muskmelon"),
      k("Berries", "Strawberry", "Blueberry", "Raspberry"),
      k("Tropical Fruits", "Mango", "Papaya", "Pineapple", "Guava", "Chikoo", "Jackfruit"),
      k("Exotic Fruits", "Kiwi", "Dragon Fruit", "Avocado", "Imported Pear"),
    ],
  },
  {
    n: "Vegetables", f: [organic, origin],
    k: [
      k("Root Vegetables", "Potato", "Carrot", "Radish", "Beetroot", "Turnip"),
      k("Leafy Vegetables", "Spinach", "Methi", "Coriander", "Mint", "Lettuce"),
      k("Gourds", "Bottle Gourd", "Bitter Gourd", "Ridge Gourd", "Pumpkin"),
      k("Cruciferous", "Cauliflower", "Cabbage", "Broccoli"),
      k("Beans & Peas", "Green Beans", "Green Peas", "Broad Beans"),
      k("Fruiting Vegetables", "Tomato", "Brinjal", "Capsicum", "Ladyfinger", "Cucumber"),
      k("Specialty Vegetables", "Mushroom", "Zucchini", "Baby Corn", "Asparagus", "Jalapeño"),
    ],
  },
  {
    n: "Fresh Herbs", f: [organic],
    k: leaves("Coriander", "Mint", "Curry Leaves", "Basil", "Parsley", "Dill", "Rosemary", "Thyme", "Lemongrass"),
  },
  {
    n: "Cut & Pre-Cut", f: [num("use_within", "Use within", { unit: "days", showOnCard: true })],
    k: [
      k("Cut Fruits", "Cut Watermelon", "Cut Papaya", "Cut Pineapple", "Mixed Fruit"),
      k("Cut Vegetables", "Chopped Onion", "Chopped Tomato", "Mixed Vegetables", "Salad Mix"),
      k("Prepared Fresh Produce", "Peeled Vegetables", "Chopped Vegetables", "Grated Vegetables"),
    ],
  },
  {
    n: "Fresh Bakery", f: [yn("eggless", "Eggless", { filterable: true }), num("use_within", "Use within", { unit: "days" })],
    k: [
      k("Bread", "White Bread", "Brown Bread", "Multigrain Bread", "Whole Wheat Bread"),
      k("Buns & Pav", "Pav", "Burger Buns", "Hot Dog Buns"),
      k("Bakery Basics", "Pizza Base", "Tortilla", "Pita Bread"),
    ],
  },
];

/** Existing products that belong in the new tree: [exact name, path under the root slug]. Matched once, case-insensitive. */
export const FRESH_DAIRY_MOVES: { name: string; from: string; path: string[] }[] = [
  { name: "Tomato", from: "fresh", path: ["Vegetables", "Fruiting Vegetables", "Tomato"] },
  { name: "Toned Milk", from: "dairy", path: ["Dairy", "Milk", "Toned Milk"] },
  { name: "Creamy Curd", from: "dairy", path: ["Dairy", "Curd & Yogurt"] },
  { name: "Fresh Curd", from: "dairy", path: ["Dairy", "Curd & Yogurt"] },
  { name: "Farm Eggs", from: "dairy", path: ["Eggs", "Chicken Eggs"] },
];
