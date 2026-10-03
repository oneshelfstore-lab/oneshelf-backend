// Grocery & Food: 12 categories → children → grandchildren, as supplied. Packaged, processed, dried, canned and
// shelf-stable food only. Fresh produce, dairy, eggs, fresh herbs and fresh bread are Fresh & Dairy; prepared meals and
// restaurant dishes are the food-delivery layer, not here. Brand, pack size, flavour, diet type, organic and shelf life are
// product FIELDS/variants. Loaded by scripts/seedTree.ts.
//
// Seven roots REUSE existing rows (Root.slug) so their ids — and anything keyed on them (banners, commission overrides,
// Home chips) — survive; their old sub-categories are deactivated by the seeder once the products have moved.
// Kept as supplied: Pancake Mix (Breakfast Mixes + Baking Mixes), Peanuts (Nuts + Indian Snacks), Oats (Grains + Breakfast).
import type { Root } from "./stationeryCatalog.js";
import { leaves, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const diet = pick("diet", "Diet", ["Vegetarian", "Non-vegetarian", "Vegan"], { filterable: true, showOnCard: true });
const organic = yn("organic", "Organic", { filterable: true });
const flavour = t("flavour", "Flavour", { filterable: true, showOnCard: true });
const packType = pick("pack_type", "Pack type", ["Pouch", "Packet", "Bottle", "Jar", "Tin / Can", "Box", "Loose / by weight"], { filterable: true });
const shelfLife = t("shelf_life", "Shelf life / best before");
const base = [diet, organic];

export const GROCERY: Root[] = [
  {
    n: "Staples & Grains", slug: "staples_grains", f: [organic, t("origin", "Origin")],
    k: [
      k("Rice", "Basmati Rice", "Non-Basmati Rice", "Sella Rice", "Brown Rice"),
      k("Wheat & Flour", "Atta", "Maida", "Besan", "Multigrain Flour", "Other Flour"),
      k("Millets", "Bajra", "Jowar", "Ragi", "Millet Mix"),
      k("Grains", "Quinoa", "Barley", "Oats", "Dalia"),
    ],
  },
  {
    n: "Pulses & Dals", f: [organic, t("origin", "Origin")],
    k: [
      k("Whole Pulses", "Whole Moong", "Whole Masoor", "Whole Urad", "Whole Chana"),
      k("Split Dals", "Toor Dal", "Moong Dal", "Masoor Dal", "Urad Dal", "Chana Dal"),
      k("Beans", "Rajma", "Kabuli Chana", "Black Chana", "Lobia"),
    ],
  },
  {
    n: "Cooking Oils & Ghee", f: [packType, organic],
    k: [
      k("Edible Oils", "Mustard Oil", "Sunflower Oil", "Soybean Oil", "Groundnut Oil", "Rice Bran Oil", "Coconut Oil"),
      k("Specialty Oils", "Olive Oil", "Sesame Oil", "Flaxseed Oil"),
      k("Ghee", "Cow Ghee", "Buffalo Ghee", "A2 Ghee", "Organic Ghee"),
    ],
  },
  {
    n: "Spices & Masalas", slug: "oils_spices_masalas", f: [organic, packType],
    k: [
      k("Whole Spices", "Cumin", "Coriander Seeds", "Black Pepper", "Cardamom", "Cloves", "Cinnamon"),
      k("Ground Spices", "Turmeric Powder", "Red Chilli Powder", "Coriander Powder", "Cumin Powder", "Black Pepper Powder"),
      k("Blended Masalas", "Garam Masala", "Chaat Masala", "Kitchen King Masala", "Biryani Masala", "Curry Masala"),
      k("Salt", "Iodized Salt", "Rock Salt", "Black Salt", "Sea Salt"),
    ],
  },
  {
    n: "Sugar & Sweeteners", f: [organic],
    k: [
      k("Sugar", "White Sugar", "Brown Sugar", "Powdered Sugar"),
      k("Natural Sweeteners", "Jaggery", "Jaggery Powder", "Honey"),
      k("Sugar Alternatives", "Stevia", "Erythritol", "Sugar-Free Sweetener"),
    ],
  },
  {
    n: "Dry Fruits, Nuts & Seeds", f: [organic, t("origin", "Origin"), pick("form", "Form", ["Whole", "Roasted", "Salted", "Sliced / chopped", "Powder"], { filterable: true })],
    k: [
      k("Dry Fruits", "Almonds", "Cashews", "Raisins", "Dates", "Figs"),
      k("Nuts", "Walnuts", "Pistachios", "Peanuts", "Hazelnuts"),
      k("Seeds", "Chia Seeds", "Flax Seeds", "Pumpkin Seeds", "Sunflower Seeds", "Sesame Seeds"),
    ],
  },
  {
    n: "Snacks", slug: "snacks_namkeen", f: [...base, flavour],
    k: [
      k("Chips & Crisps", "Potato Chips", "Banana Chips", "Corn Chips", "Namkeen"),
      k("Biscuits & Cookies", "Biscuits", "Cream Biscuits", "Cookies", "Crackers"),
      k("Indian Snacks", "Bhujia", "Mixture", "Sev", "Peanuts"),
      k("Healthy Snacks", "Granola Bar", "Protein Bar", "Roasted Snacks", "Trail Mix"),
    ],
  },
  {
    n: "Breakfast Foods", slug: "bakery_breakfast", f: [...base, flavour],
    k: [
      k("Cereals", "Corn Flakes", "Muesli", "Granola", "Choco Cereal"),
      k("Oats", "Rolled Oats", "Instant Oats", "Flavoured Oats"),
      k("Spreads", "Peanut Butter", "Chocolate Spread", "Fruit Spread", "Jam"),
      k("Breakfast Mixes", "Pancake Mix", "Dosa Mix", "Idli Mix", "Upma Mix"),
    ],
  },
  {
    n: "Tea, Coffee & Beverages", slug: "beverages", f: [packType, flavour],
    k: [
      { ...k("Tea", "Black Tea", "Green Tea", "Masala Tea", "Herbal Tea"), f: [pick("tea_form", "Form", ["Leaf", "Dust / CTC", "Tea bags"], { filterable: true })] },
      { ...k("Coffee", "Instant Coffee", "Ground Coffee", "Coffee Premix"), f: [pick("roast", "Roast", ["Light", "Medium", "Dark"], { filterable: true })] },
      k("Drink Mixes", "Health Drink Mix", "Chocolate Drink Mix", "Lemon Drink Mix", "Milkshake Mix"),
      k("Packaged Beverages", "Packaged Juice", "Coconut Water", "Soft Drink", "Energy Drink"),
    ],
  },
  {
    n: "Packaged & Ready Foods", slug: "packaged_canned", f: [...base],
    k: [
      k("Instant Foods", "Instant Noodles", "Instant Pasta", "Instant Soup", "Instant Poha"),
      k("Pasta & Noodles", "Pasta", "Macaroni", "Vermicelli", "Noodles"),
      k("Canned & Packaged Foods", "Canned Beans", "Canned Corn", "Canned Fruits", "Packaged Vegetables"),
      k("Ready-to-Cook", "Ready-to-Cook Mix", "Cooking Sauce", "Instant Meal", "Meal Kit"),
    ],
  },
  {
    n: "Sauces, Spreads & Condiments", f: [...base, flavour, packType],
    k: [
      k("Sauces", "Tomato Ketchup", "Chilli Sauce", "Soy Sauce", "Pasta Sauce"),
      k("Pickles", "Mango Pickle", "Lemon Pickle", "Mixed Pickle"),
      k("Chutneys", "Mint Chutney", "Tamarind Chutney", "Cooking Chutney"),
      k("Vinegar", "White Vinegar", "Apple Cider Vinegar", "Balsamic Vinegar"),
    ],
  },
  {
    n: "Baking Ingredients", f: [...base],
    k: [
      k("Baking Essentials", "Baking Powder", "Baking Soda", "Yeast", "Cocoa Powder"),
      k("Baking Mixes", "Cake Mix", "Brownie Mix", "Pancake Mix", "Muffin Mix"),
      k("Baking Decorations", "Sprinkles", "Food Colour", "Cake Decorations", "Dessert Toppings"),
    ],
  },
  {
    n: "Chocolates & Confectionery", slug: "confectionery", f: [diet, flavour],
    k: [
      k("Chocolates", "Chocolate Bar", "Chocolate Box", "Dark Chocolate", "White Chocolate"),
      k("Candies", "Hard Candy", "Toffee", "Lollipop", "Jelly Candy"),
      k("Gum & Mints", "Chewing Gum", "Mint", "Mouth Freshener"),
    ],
  },
  {
    n: "International & Specialty Foods", f: [...base],
    k: [
      k("International Foods", "Asian Foods", "Italian Foods", "Mexican Foods", "Imported Foods"),
      k("Organic Foods", "Organic Grains", "Organic Pulses", "Organic Spices", "Organic Snacks"),
      k("Specialty Foods", "Gluten-Free Foods", "Sugar-Free Foods", "Vegan Foods", "Keto Foods"),
    ],
  },
];

type Move = { name?: string; subcategory?: string; from: string; path: string[] };
const S = "Staples & Grains", O = "Cooking Oils & Ghee", SP = "Spices & Masalas", SN = "Snacks", BV = "Tea, Coffee & Beverages";
const BF = "Breakfast Foods", PR = "Packaged & Ready Foods", CC = "Chocolates & Confectionery", SC = "Sauces, Spreads & Condiments";
const from = (root: string, rows: [string | { s: string }, string[]][]): Move[] =>
  rows.map(([m, path]) => ({ from: root, ...(typeof m === "string" ? { name: m } : { subcategory: m.s }), path }));

/**
 * Existing products → the new tree. Within each old root the NAME moves come first and the sub-category catch-alls after
 * (a moved product has left its old root, so a later catch-all never sees it).
 * Not moved (no home in this tree, or not grocery): the 2 breads (→ Fresh & Dairy > Fresh Bakery), Kaveri Mehandi
 * (→ Personal Care), Rubber Band Packet (→ Stationery), 2 "demo product" rows, 2 agarbatti in insect_killer,
 * and the whole Spiritual & Pooja category.
 */
export const GROCERY_MOVES: Move[] = [
  ...from("staples_grains", [
    ["heeng papdi", [SN, "Indian Snacks"]],
    ["paras desi ghee", [O, "Ghee"]], ["rath vanaspati ghee", [O, "Ghee"]], ["Patanjali Ghee", [O, "Ghee"]], ["deepanjali pooja ghee", [O, "Ghee"]],
    ["Americana coconut cookies", [SN, "Biscuits & Cookies", "Cookies"]],
    ["Kellogs Oats", [BF, "Oats"]],
    ["Sabudana Packet", [S, "Grains"]],
    ["Dalia", [S, "Grains", "Dalia"]],
    ["Vermicelli Roasted", [PR, "Pasta & Noodles", "Vermicelli"]], ["Thick vermicelli", [PR, "Pasta & Noodles", "Vermicelli"]],
    ["Fine vermicelli", [PR, "Pasta & Noodles", "Vermicelli"]], ["vermicelli Non Roasted", [PR, "Pasta & Noodles", "Vermicelli"]],
    [{ s: "Rice" }, [S, "Rice"]],
    [{ s: "Atta & Flours" }, [S, "Wheat & Flour"]], [{ s: "Aata & Flour" }, [S, "Wheat & Flour"]], [{ s: "Sooji, Besan & Rava" }, [S, "Wheat & Flour"]],
    [{ s: "Millets &Grains" }, [S, "Millets"]],
    [{ s: "Poha & Other Grains" }, [S, "Grains"]],
    [{ s: "Dals & Pulses" }, ["Pulses & Dals"]], [{ s: "Soya Products" }, ["Pulses & Dals"]],
    [{ s: "Dry Fruits &Nuts" }, ["Dry Fruits, Nuts & Seeds"]],
    [{ s: "Seeds" }, ["Dry Fruits, Nuts & Seeds", "Seeds"]],
    [{ s: "Sugar & Jaggery" }, ["Sugar & Sweeteners"]],
    [{ s: "Honey" }, ["Sugar & Sweeteners", "Natural Sweeteners", "Honey"]],
    [{ s: "Salt" }, [SP, "Salt"]],
    [{ s: "Baking Essentials" }, ["Baking Ingredients", "Baking Essentials"]],
    [{ s: "Pickles" }, [SC, "Pickles"]],
  ]),
  ...from("oils_spices_masalas", [
    ["Fortune Sunflower Oil", [O, "Edible Oils", "Sunflower Oil"]],
    ["Kaali Mirch Powder", [SP, "Ground Spices", "Black Pepper Powder"]], ["Red Chilli Powder", [SP, "Ground Spices", "Red Chilli Powder"]],
    ["Dhaniya Powder", [SP, "Ground Spices", "Coriander Powder"]], ["Haldi Powder", [SP, "Ground Spices", "Turmeric Powder"]],
    ["Dry Ginger Powder", [SP, "Ground Spices"]],
    ["Jeera sabut", [SP, "Whole Spices", "Cumin"]],
    ["Maggi Masala", [SP, "Blended Masalas"]], ["Achar Masala", [SP, "Blended Masalas"]],
    ["Victory Rock Salt", [SP, "Salt", "Rock Salt"]], ["Victory Black Salt", [SP, "Salt", "Black Salt"]],
    ["Gola Lachha", ["Sugar & Sweeteners"]],
    ["Kanki Gond", [SP]], ["Jayka Hing", [SP]], ["Himalaya Hing", [SP]], ["Goldiee Heeng", [SP]],
    [{ s: "Cooking Oils" }, [O, "Edible Oils"]],
    [{ s: "Whole Spices" }, [SP, "Whole Spices"]], [{ s: "Ground Spices" }, [SP, "Ground Spices"]],
    [{ s: "Blended Masalas" }, [SP, "Blended Masalas"]], [{ s: "packed spices" }, [SP, "Blended Masalas"]],
    [{ s: "Heeng" }, [SP]],
  ]),
  ...from("beverages", [
    ["Coca-Cola", [BV, "Packaged Beverages", "Soft Drink"]],
    ["Nescafe coffee", [BV, "Coffee", "Instant Coffee"]],
    ["Horlicks", [BV, "Drink Mixes", "Health Drink Mix"]], ["Bournvita", [BV, "Drink Mixes", "Health Drink Mix"]],
    ["Chocolate Powder", [BV, "Drink Mixes", "Chocolate Drink Mix"]],
    ["Raghunath tea", [BV, "Tea"]], ["Taj mahal", [BV, "Tea"]], ["patent", [BV, "Tea"]], ["Tata premium", [BV, "Tea"]], ["Tata agni", [BV, "Tea"]],
    ["Taaza", [BV, "Tea"]], ["447 Tea", [BV, "Tea"]], ["Tata Tea Agni Elaichi", [BV, "Tea"]],
    [{ s: "Tea" }, [BV, "Tea"]], [{ s: "Coffee & chocolate powder" }, [BV, "Coffee"]],
    [{ s: "Juices & Mixes" }, [BV, "Drink Mixes"]], [{ s: "Beverages" }, [BV, "Drink Mixes"]],
  ]),
  ...from("snacks_namkeen", [
    ["Parle-G Biscuits", [SN, "Biscuits & Cookies", "Biscuits"]],
    [{ s: "Namkeen & Mixtures" }, [SN, "Indian Snacks"]], [{ s: "Biscuits & Cookies" }, [SN, "Biscuits & Cookies"]],
  ]),
  ...from("confectionery", [
    ["Jaljeera", [BV, "Drink Mixes"]],
    ["Hing goli", [CC, "Gum & Mints", "Mouth Freshener"]], ["Hajmola Pudina", [CC, "Gum & Mints", "Mouth Freshener"]], ["Hajmola Regular", [CC, "Gum & Mints", "Mouth Freshener"]],
    ["Oreo", [SN, "Biscuits & Cookies", "Cream Biscuits"]], ["CNC Biscuit", [SN, "Biscuits & Cookies", "Biscuits"]], ["Anmol 2in1 biscuit", [SN, "Biscuits & Cookies", "Biscuits"]],
    [{ s: "Toffee" }, [CC, "Candies", "Toffee"]], [{ s: "Toffees" }, [CC, "Candies", "Toffee"]],
    [{ s: "Chocolates" }, [CC, "Chocolates"]],
    [{ s: "Sauce & Vinegar" }, [SC, "Sauces"]], [{ s: "Sauce &Vinegar" }, [SC, "Sauces"]],
    [{ s: "Jam" }, [BF, "Spreads", "Jam"]],
    [{ s: "Biscuits & Cookies" }, [SN, "Biscuits & Cookies"]],
    [{ s: "mouth freshener & digestive items" }, [CC, "Gum & Mints", "Mouth Freshener"]],
    [{ s: "Namkeen & Mixtures" }, [SN, "Indian Snacks"]],
    [{ s: "Ready To Eat Products" }, [PR, "Ready-to-Cook"]], [{ s: "Ready to cook products" }, [PR, "Ready-to-Cook"]],
    [{ s: "Chips" }, [SN, "Chips & Crisps"]],
  ]),
  ...from("packaged_canned", [
    ["jelly", [CC, "Candies", "Jelly Candy"]],
    ["Paras Milk Powder", [BV, "Drink Mixes"]],
  ]),
];
