// Home & Kitchen: 11 categories → children → grandchildren, as supplied, plus light per-category product fields.
// Loaded by scripts/seedTree.ts (see data/catalogTrees.ts).
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const material = (...options: string[]) => pick("material", "Material", options, { filterable: true, showOnCard: true });
const colour = t("colour", "Colour", { filterable: true });
const capacityL = num("capacity", "Capacity", { unit: "L", filterable: true, showOnCard: true });
const capacityMl = num("capacity", "Capacity", { unit: "ml", filterable: true, showOnCard: true });
const induction = yn("induction", "Induction compatible", { filterable: true });
const pieces = num("pieces", "Pieces in set", { showOnCard: true });

export const HOME_KITCHEN: Root[] = [
  {
    n: "Kitchen",
    f: [material("Stainless steel", "Aluminium", "Non-stick", "Cast iron", "Copper", "Brass", "Glass", "Plastic", "Wood", "Silicone")],
    k: [
      { ...k("Cookware", "Kadhai", "Fry Pan", "Sauce Pan", "Tawa", "Handi", "Cooking Pot", "Wok", "Stock Pot", "Steamer"), f: [capacityL, induction] },
      { ...k("Pressure Cookers", "Pressure Cooker", "Cooker Gasket", "Safety Valve", "Cooker Whistle", "Cooker Accessories"), f: [capacityL, induction] },
      k("Kitchen Tools", "Spatula", "Ladle", "Tongs", "Whisk", "Peeler", "Grater", "Slicer", "Garlic Press", "Lemon Squeezer", "Bottle Opener", "Can Opener"),
      k("Knives & Cutting", "Kitchen Knife", "Chef Knife", "Vegetable Knife", "Bread Knife", "Knife Set", "Chopping Board", "Knife Sharpener"),
      k("Strainers & Sieves", "Strainer", "Colander", "Tea Strainer", "Flour Sieve"),
      k("Measuring Tools", "Measuring Cup", "Measuring Spoon", "Measuring Jug", "Kitchen Scale"),
    ],
  },
  {
    n: "Crockery & Dining",
    f: [material("Ceramic", "Bone china", "Glass", "Melamine", "Stainless steel", "Plastic", "Wood"), yn("dishwasher_safe", "Dishwasher safe", { filterable: true })],
    k: [
      k("Plates", "Dinner Plate", "Quarter Plate", "Side Plate", "Compartment Plate", "Kids' Plate"),
      k("Bowls", "Serving Bowl", "Soup Bowl", "Cereal Bowl", "Dessert Bowl", "Katori"),
      k("Cups & Mugs", "Tea Cup", "Coffee Cup", "Mug", "Glass Cup", "Cup & Saucer Set"),
      k("Glassware", "Drinking Glass", "Juice Glass", "Tumbler", "Wine Glass", "Specialty Glass"),
      k("Cutlery", "Spoon", "Fork", "Knife", "Chopstick", "Cutlery Set"),
      { ...k("Dinner Sets", "2-Person Set", "4-Person Set", "6-Person Set", "8-Person Set", "Complete Dinner Set"), f: [pieces] },
      k("Serving Ware", "Serving Tray", "Serving Platter", "Serving Bowl", "Serving Spoon", "Serving Set"),
      k("Table Accessories", "Napkin Holder", "Tissue Holder", "Salt & Pepper Set", "Coaster", "Table Mat"),
    ],
  },
  {
    n: "Kitchen Storage & Organization",
    f: [material("Plastic", "Glass", "Stainless steel", "Wood", "Bamboo", "Ceramic")],
    k: [
      { ...k("Food Storage", "Airtight Container", "Plastic Container", "Glass Container", "Steel Container", "Storage Set"), f: [num("capacity", "Capacity", { unit: "ml", filterable: true, showOnCard: true }), yn("airtight", "Airtight", { filterable: true }), pieces] },
      k("Spice Storage", "Masala Box", "Spice Jar", "Spice Rack", "Spice Container"),
      k("Kitchen Organizers", "Cabinet Organizer", "Drawer Organizer", "Bottle Organizer", "Lid Organizer", "Shelf Organizer"),
      { ...k("Food Storage Accessories", "Zip Lock Bag", "Food Storage Bag", "Aluminium Foil", "Cling Film", "Butter Paper"), f: [num("length", "Length", { unit: "m", showOnCard: true }), num("pack_count", "Pieces in pack")] },
    ],
  },
  {
    n: "Bakeware",
    f: [material("Aluminium", "Stainless steel", "Non-stick", "Silicone", "Glass", "Ceramic")],
    k: [
      k("Baking Trays", "Aluminium Baking Tray", "Steel Baking Tray", "Non-Stick Baking Tray"),
      k("Baking Moulds", "Cake Mould", "Bread Mould", "Muffin Mould", "Cupcake Mould", "Silicone Mould"),
      k("Baking Dishes", "Glass Baking Dish", "Ceramic Baking Dish", "Ramekin"),
      k("Baking Tools", "Rolling Pin", "Dough Scraper", "Pastry Brush", "Cake Decorating Tool"),
    ],
  },
  {
    n: "Kitchen Utility",
    k: [
      { ...k("Kitchen Bins", "Dustbin", "Pedal Bin", "Swing Bin", "Countertop Bin"), f: [capacityL, colour] },
      k("Sink Accessories", "Sink Organizer", "Sink Strainer", "Sponge Holder", "Faucet Accessories"),
      k("Kitchen Accessories", "Kitchen Towel", "Apron", "Oven Mitt", "Pot Holder", "Kitchen Timer"),
    ],
  },
  {
    n: "Water & Beverage Storage",
    f: [capacityMl, colour],
    k: [
      { ...k("Water Bottles", "Plastic Bottle", "Steel Bottle", "Glass Bottle", "Copper Bottle"), f: [yn("leak_proof", "Leak proof", { filterable: true })] },
      { ...k("Flasks & Thermos", "Thermos Flask", "Vacuum Flask", "Insulated Bottle"), f: [num("keeps_hot", "Keeps hot", { unit: "hrs" }), num("keeps_cold", "Keeps cold", { unit: "hrs" })] },
      k("Jugs & Pitchers", "Water Jug", "Pitcher", "Carafe"),
    ],
  },
  {
    n: "Home Storage & Organization",
    f: [material("Plastic", "Fabric", "Wood", "Metal", "Wire", "Bamboo"), colour],
    k: [
      k("Storage Boxes", "Plastic Storage Box", "Fabric Storage Box", "Stackable Box", "Under-Bed Storage"),
      k("Baskets", "Storage Basket", "Plastic Basket", "Wire Basket", "Multipurpose Basket"),
      { ...k("Hangers", "Clothes Hanger", "Trouser Hanger", "Clip Hanger", "Hanger Set"), f: [num("pack_count", "Pieces in pack", { showOnCard: true })] },
      k("Organizers", "Drawer Organizer", "Wardrobe Organizer", "Multipurpose Organizer", "Shelf Organizer"),
    ],
  },
  {
    n: "Laundry & Utility",
    f: [colour],
    k: [
      k("Laundry Baskets", "Plastic Laundry Basket", "Folding Laundry Basket", "Laundry Hamper"),
      k("Clothes Drying", "Drying Rack", "Clothes Line", "Cloth Clips"),
      k("Ironing", "Ironing Board", "Ironing Mat", "Iron Stand"),
    ],
  },
  {
    n: "Bathroom Accessories",
    f: [material("Plastic", "Stainless steel", "Ceramic", "Acrylic", "Brass"), colour],
    k: [
      k("Bathroom Storage", "Shower Caddy", "Bathroom Organizer", "Corner Shelf", "Bathroom Rack"),
      k("Holders", "Soap Dish", "Toothbrush Holder", "Towel Holder", "Toilet Roll Holder"),
      k("Bathroom Utility", "Bath Stool", "Bathroom Bucket", "Bathroom Mug", "Shower Accessories"),
    ],
  },
  {
    n: "Home Utility",
    k: [
      k("General Utility", "Step Stool", "Folding Stool", "Utility Rope", "Sewing Kit", "Utility Scissors"),
      k("Hooks & Holders", "Wall Hook", "Adhesive Hook", "Door Hook", "Multipurpose Holder"),
    ],
  },
  {
    n: "Home Decor",
    f: [colour, t("material", "Material", { filterable: true })],
    k: [
      k("Decorative Items", "Showpiece", "Figurine", "Decorative Bowl", "Decorative Tray"),
      k("Vases & Plants", "Flower Vase", "Artificial Flower", "Artificial Plant"),
      k("Wall Decor", "Wall Hanging", "Photo Frame", "Decorative Mirror"),
      { ...k("Candles & Holders", "Decorative Candle", "Candle Holder", "Candle Stand"), f: [t("fragrance", "Fragrance")] },
    ],
  },
];

/** Existing products that belong in this tree (exact name, within the `from` root). Match boxes etc. stay in household_personal. */
export const HOME_KITCHEN_MOVES: { name?: string; subcategory?: string; from: string; path: string[] }[] = [
  { name: "Metal candy/ dry fruits tray", from: "crockery", path: ["Crockery & Dining", "Serving Ware", "Serving Tray"] },
  { name: "Candle", from: "household_personal", path: ["Home Decor", "Candles & Holders", "Decorative Candle"] },
];
