import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const hsnCodes = [
  // ═══════════════════════════════════════════════════════════════════════
  // EXEMPT (0% GST) — loose/unbranded staples, fresh produce, dairy
  // ═══════════════════════════════════════════════════════════════════════
  // Dairy & eggs
  { code: "0401", description: "Fresh milk (all types — cow, buffalo, goat)", defaultGstRate: 0, category: "DAIRY", isExempt: true },
  { code: "0401", description: "Curd / yogurt (natural, not flavoured)", defaultGstRate: 0, category: "DAIRY", isExempt: true },
  { code: "0401", description: "Lassi, buttermilk (fresh/UHT)", defaultGstRate: 0, category: "DAIRY", isExempt: true },
  { code: "0401", description: "UHT milk (tetra-pack)", defaultGstRate: 0, category: "DAIRY", isExempt: true },
  { code: "0401", description: "Paneer / chena (pre-packaged & labelled)", defaultGstRate: 0, category: "DAIRY", isExempt: true },
  { code: "0403", description: "Buttermilk, curdled milk, kefir", defaultGstRate: 0, category: "DAIRY", isExempt: true },
  { code: "0407", description: "Fresh eggs (hen, duck)", defaultGstRate: 0, category: "DAIRY", isExempt: true },
  // Fresh vegetables
  { code: "0701", description: "Potatoes (fresh)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  { code: "0702", description: "Tomatoes (fresh)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  { code: "0703", description: "Onions, garlic, leeks (fresh)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  { code: "0704", description: "Cabbage, cauliflower, broccoli (fresh)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  { code: "0705", description: "Lettuce, chicory (fresh)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  { code: "0706", description: "Carrots, radish, turnips (fresh)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  { code: "0707", description: "Cucumber, gherkins (fresh)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  { code: "0708", description: "Peas, beans — leguminous (fresh)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  { code: "0709", description: "Other fresh vegetables (capsicum, okra, spinach, etc.)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  { code: "0710", description: "Frozen vegetables (uncooked)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  { code: "0714", description: "Roots & tubers (tapioca, sweet potato)", defaultGstRate: 0, category: "FRESH_VEGETABLES", isExempt: true },
  // Fresh fruits
  { code: "0803", description: "Bananas (fresh)", defaultGstRate: 0, category: "FRESH_FRUITS", isExempt: true },
  { code: "0804", description: "Mangoes, guava, papaya (fresh)", defaultGstRate: 0, category: "FRESH_FRUITS", isExempt: true },
  { code: "0805", description: "Citrus fruits — orange, lemon, mosambi (fresh)", defaultGstRate: 0, category: "FRESH_FRUITS", isExempt: true },
  { code: "0806", description: "Grapes (fresh)", defaultGstRate: 0, category: "FRESH_FRUITS", isExempt: true },
  { code: "0807", description: "Melons, watermelon (fresh)", defaultGstRate: 0, category: "FRESH_FRUITS", isExempt: true },
  { code: "0808", description: "Apples, pears (fresh)", defaultGstRate: 0, category: "FRESH_FRUITS", isExempt: true },
  { code: "0810", description: "Other fresh fruits (pomegranate, litchi, chikoo, etc.)", defaultGstRate: 0, category: "FRESH_FRUITS", isExempt: true },
  // Staples (loose/unbranded)
  { code: "0713", description: "Pulses — dried (loose/unbranded: toor, chana, moong, masoor, urad)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1001", description: "Wheat (loose/unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1005", description: "Maize / corn (loose)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1006", description: "Rice (loose/unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1007", description: "Jowar / sorghum (loose)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1008", description: "Bajra / ragi / millets (loose)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1101", description: "Wheat flour / atta (loose/unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1102", description: "Besan, rice flour, other cereal flour (loose/unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1103", description: "Dalia, semolina / suji / rava (loose/unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1104", description: "Rolled / flaked cereals — poha, oats (unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1905", description: "Indian breads — chapati, roti, paratha (unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "2501", description: "Salt (unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1202", description: "Groundnuts / peanuts (unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "0801", description: "Dry fruits — coconut, cashew, walnut, almond (loose/unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "1207", description: "Other oil seeds — flaxseed, chia, etc. (unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  // Spices (loose/unbranded)
  { code: "0904", description: "Pepper (loose/unbranded)", defaultGstRate: 0, category: "SPICES", isExempt: true },
  { code: "0910", description: "Turmeric, ginger, other spices (loose/unbranded)", defaultGstRate: 0, category: "SPICES", isExempt: true },
  { code: "0909", description: "Cumin, coriander, fennel seeds (loose/unbranded)", defaultGstRate: 0, category: "SPICES", isExempt: true },
  // Other exempt
  { code: "1704", description: "Jaggery / gur (all types)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },
  { code: "2106", description: "Papad (unbranded)", defaultGstRate: 0, category: "GROCERY_STAPLES", isExempt: true },

  // ═══════════════════════════════════════════════════════════════════════
  // 5% GST — branded packaged staples, edible oils, tea/coffee, bakery
  // ═══════════════════════════════════════════════════════════════════════
  // Dairy (branded/packaged)
  { code: "0402", description: "Milk powder, condensed milk, flavoured milk", defaultGstRate: 5, category: "DAIRY" },
  { code: "0403", description: "Flavoured yogurt / probiotic drinks (packaged)", defaultGstRate: 5, category: "DAIRY" },
  { code: "0405", description: "Ghee, butter (all types)", defaultGstRate: 5, category: "DAIRY" },
  { code: "0406", description: "Cheese, paneer (branded packaged)", defaultGstRate: 5, category: "DAIRY" },
  // Staples (branded packaged)
  { code: "0713", description: "Pulses — dried (branded packaged: toor, chana, moong, masoor, urad)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "1001", description: "Wheat (branded packaged)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "1006", description: "Rice (branded packaged — basmati, sona masoori, etc.)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "1101", description: "Wheat flour / atta (branded packaged)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "1102", description: "Besan, rice flour, other cereal flour (branded packaged)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "1103", description: "Semolina / suji / rava / dalia (branded packaged)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "1104", description: "Poha, rolled oats (branded packaged)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "1701", description: "Sugar — white, brown, raw (all types)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "1702", description: "Glucose, fructose syrup", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "0801", description: "Dry fruits — cashew, walnut, almond (branded packaged)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "0802", description: "Other nuts — pistachios, hazelnuts (branded packaged)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "1202", description: "Groundnuts / peanuts (branded packaged)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  { code: "2501", description: "Salt (branded — Tata, Catch, etc.)", defaultGstRate: 5, category: "GROCERY_STAPLES" },
  // Edible oils
  { code: "1507", description: "Soybean oil", defaultGstRate: 5, category: "OILS" },
  { code: "1508", description: "Groundnut oil", defaultGstRate: 5, category: "OILS" },
  { code: "1509", description: "Olive oil", defaultGstRate: 5, category: "OILS" },
  { code: "1510", description: "Other fixed vegetable oils (sesame, palm kernel)", defaultGstRate: 5, category: "OILS" },
  { code: "1511", description: "Palm oil (edible)", defaultGstRate: 5, category: "OILS" },
  { code: "1512", description: "Sunflower oil, safflower oil", defaultGstRate: 5, category: "OILS" },
  { code: "1513", description: "Coconut oil (edible grade)", defaultGstRate: 5, category: "OILS" },
  { code: "1514", description: "Rapeseed / canola oil", defaultGstRate: 5, category: "OILS" },
  { code: "1515", description: "Mustard oil, other edible oils", defaultGstRate: 5, category: "OILS" },
  { code: "1516", description: "Vanaspati / hydrogenated vegetable fat", defaultGstRate: 5, category: "OILS" },
  // Spices (branded packaged)
  { code: "0904", description: "Pepper (branded packaged)", defaultGstRate: 5, category: "SPICES" },
  { code: "0905", description: "Vanilla (packaged)", defaultGstRate: 5, category: "SPICES" },
  { code: "0906", description: "Cinnamon, cardamom (packaged)", defaultGstRate: 5, category: "SPICES" },
  { code: "0907", description: "Cloves (packaged)", defaultGstRate: 5, category: "SPICES" },
  { code: "0908", description: "Nutmeg, mace (packaged)", defaultGstRate: 5, category: "SPICES" },
  { code: "0909", description: "Cumin, coriander, fennel seeds (packaged)", defaultGstRate: 5, category: "SPICES" },
  { code: "0910", description: "Turmeric, ginger, other spices (packaged)", defaultGstRate: 5, category: "SPICES" },
  { code: "2103", description: "Ready masala — garam masala, chaat masala, curry powder (packaged)", defaultGstRate: 5, category: "SPICES" },
  // Beverages (non-aerated)
  { code: "0901", description: "Coffee (packaged — ground, instant, beans)", defaultGstRate: 5, category: "BEVERAGES" },
  { code: "0902", description: "Tea (packaged — leaf, dust, bags)", defaultGstRate: 5, category: "BEVERAGES" },
  { code: "2009", description: "Fruit juices, pulp (packaged — Real, Tropicana, etc.)", defaultGstRate: 5, category: "BEVERAGES" },
  { code: "2202", description: "Packaged drinking water (up to 20 litres)", defaultGstRate: 5, category: "BEVERAGES" },
  // Bakery & breakfast
  { code: "1905", description: "Bread, pav, bun (bakery)", defaultGstRate: 5, category: "PACKAGED_FOOD" },
  { code: "1905", description: "Rusk, toast (packaged)", defaultGstRate: 5, category: "PACKAGED_FOOD" },
  { code: "1905", description: "Biscuits (all types — Parle-G, Marie, cream, etc.)", defaultGstRate: 5, category: "PACKAGED_FOOD" },
  { code: "1904", description: "Cornflakes, muesli, breakfast cereals (packaged)", defaultGstRate: 5, category: "PACKAGED_FOOD" },
  // Packaged food
  { code: "1902", description: "Pasta, noodles, instant noodles (Maggi, Yippee, etc.)", defaultGstRate: 5, category: "PACKAGED_FOOD" },
  { code: "2103", description: "Sauces, ketchup, mustard, mayonnaise", defaultGstRate: 5, category: "PACKAGED_FOOD" },
  { code: "2104", description: "Soup mixes, ready-to-eat soup", defaultGstRate: 5, category: "PACKAGED_FOOD" },
  { code: "2001", description: "Pickles — mango, mixed, lime (packaged)", defaultGstRate: 5, category: "PACKAGED_FOOD" },
  { code: "2007", description: "Jams, marmalade, fruit spreads", defaultGstRate: 5, category: "PACKAGED_FOOD" },
  { code: "1901", description: "Malt extract, infant food (Cerelac, Bournvita, Horlicks)", defaultGstRate: 5, category: "PACKAGED_FOOD" },
  { code: "2106", description: "Namkeen, bhujia, mixtures, papad (branded)", defaultGstRate: 5, category: "SNACKS" },
  { code: "1806", description: "Chocolate, cocoa preparations (packaged)", defaultGstRate: 5, category: "SNACKS" },
  { code: "2008", description: "Preserved fruits & nuts, fruit bars", defaultGstRate: 5, category: "SNACKS" },
  // Frozen
  { code: "2105", description: "Ice cream, kulfi (branded)", defaultGstRate: 5, category: "FROZEN" },
  { code: "1602", description: "Frozen meat / chicken (packaged)", defaultGstRate: 5, category: "FROZEN" },
  // Personal care & household (5%)
  { code: "3401", description: "Soap — bathing bar, handwash, liquid (all types)", defaultGstRate: 5, category: "PERSONAL_CARE" },
  { code: "3402", description: "Detergent — powder, liquid, bar (Surf, Tide, Rin, etc.)", defaultGstRate: 5, category: "PERSONAL_CARE" },
  { code: "3305", description: "Shampoo, conditioner, hair oil (packaged)", defaultGstRate: 5, category: "PERSONAL_CARE" },
  { code: "3306", description: "Toothpaste, toothbrush, mouthwash", defaultGstRate: 5, category: "PERSONAL_CARE" },
  { code: "3307", description: "Deodorant, perfume, agarbatti, dhoop", defaultGstRate: 5, category: "PERSONAL_CARE" },
  // Stationery
  { code: "9609", description: "Pencils, pens, writing instruments", defaultGstRate: 5, category: "STATIONERY" },
  { code: "4820", description: "Notebooks, registers, writing pads", defaultGstRate: 5, category: "STATIONERY" },

  // ═══════════════════════════════════════════════════════════════════════
  // 12% GST
  // ═══════════════════════════════════════════════════════════════════════
  { code: "0802", description: "Almonds, pistachios (in-shell, branded)", defaultGstRate: 12, category: "GROCERY_STAPLES" },
  { code: "2106", description: "Protein powders, health supplements", defaultGstRate: 12, category: "PACKAGED_FOOD" },
  { code: "1704", description: "Confectionery — toffees, candies (branded)", defaultGstRate: 12, category: "SNACKS" },

  // ═══════════════════════════════════════════════════════════════════════
  // 18% GST — processed food, household, cleaning
  // ═══════════════════════════════════════════════════════════════════════
  { code: "4818", description: "Toilet paper, tissues, paper towels, napkins", defaultGstRate: 18, category: "CLEANING" },
  { code: "2201", description: "Mineral water, soda water (above 20L)", defaultGstRate: 18, category: "BEVERAGES" },
  { code: "3304", description: "Beauty / skin care products, face cream, sunscreen", defaultGstRate: 18, category: "PERSONAL_CARE" },
  { code: "3808", description: "Insecticides, mosquito repellents (Good Knight, All Out)", defaultGstRate: 18, category: "CLEANING" },
  { code: "3506", description: "Adhesives — Fevicol, tape, glue", defaultGstRate: 18, category: "STATIONERY" },
  { code: "3924", description: "Plastic kitchenware — containers, bottles, tiffin", defaultGstRate: 18, category: "CLEANING" },
  { code: "3923", description: "Plastic bags, garbage bags, zip-lock bags", defaultGstRate: 18, category: "CLEANING" },
  { code: "7615", description: "Aluminium foil, cling wrap", defaultGstRate: 18, category: "CLEANING" },
  { code: "8509", description: "Batteries (dry cell — AA, AAA, 9V)", defaultGstRate: 18, category: "CLEANING" },
  { code: "3406", description: "Candles, matchboxes", defaultGstRate: 18, category: "CLEANING" },

  // ═══════════════════════════════════════════════════════════════════════
  // 28% GST — premium/luxury
  // ═══════════════════════════════════════════════════════════════════════
  { code: "3303", description: "Premium perfumes, eau de toilette", defaultGstRate: 28, category: "PERSONAL_CARE" },

  // ═══════════════════════════════════════════════════════════════════════
  // 40% GST (sin goods — GST 2.0 eff Sep 2025)
  // ═══════════════════════════════════════════════════════════════════════
  { code: "2202", description: "Aerated drinks, caffeinated beverages (Coke, Pepsi, energy drinks)", defaultGstRate: 40, category: "SIN_GOODS" },
  { code: "2402", description: "Cigarettes, tobacco products", defaultGstRate: 40, category: "SIN_GOODS" },
  { code: "2403", description: "Gutka, pan masala (with tobacco)", defaultGstRate: 40, category: "SIN_GOODS" },
];

// Legacy billing products (plain strings — no Prisma enum)
const sampleProducts = [
  { name: "Tata Salt (1 kg)", sku: "SALT-TATA-1KG", hsnCode: "2501", category: "GROCERY_STAPLES", gstRate: 0, mrp: 28, sellingPrice: 28, costPrice: 22, unit: "PKT", isExempt: true },
  { name: "Amul Gold Milk (1 L)", sku: "MILK-AMUL-GOLD-1L", hsnCode: "0401", category: "DAIRY", gstRate: 0, mrp: 68, sellingPrice: 68, costPrice: 60, unit: "PKT", isExempt: true, isBranded: true },
  { name: "Aashirvaad Atta (5 kg)", sku: "ATTA-AASHI-5KG", hsnCode: "1101", category: "GROCERY_STAPLES", gstRate: 5, mrp: 290, sellingPrice: 275, costPrice: 240, unit: "PKT", isBranded: true },
  { name: "Fortune Sunflower Oil (1 L)", sku: "OIL-FORT-SUN-1L", hsnCode: "1512", category: "OILS", gstRate: 5, mrp: 155, sellingPrice: 145, costPrice: 128, unit: "LTR", isBranded: true },
  { name: "Parle-G Biscuits (800 g)", sku: "BISC-PARLEG-800G", hsnCode: "1905", category: "SNACKS", gstRate: 5, mrp: 80, sellingPrice: 76, costPrice: 62, unit: "PKT", isBranded: true },
  { name: "Maggi Noodles (Family Pack, 560 g)", sku: "NOODLE-MAGGI-560G", hsnCode: "1902", category: "PACKAGED_FOOD", gstRate: 5, mrp: 114, sellingPrice: 108, costPrice: 90, unit: "PKT", isBranded: true },
  { name: "Surf Excel Detergent (1 kg)", sku: "DET-SURF-1KG", hsnCode: "3401", category: "CLEANING", gstRate: 5, mrp: 185, sellingPrice: 175, costPrice: 148, unit: "PKT", isBranded: true },
  { name: "Coca-Cola (750 ml)", sku: "DRINK-COKE-750ML", hsnCode: "2202", category: "BEVERAGES", gstRate: 40, mrp: 40, sellingPrice: 40, costPrice: 30, unit: "PCS", isBranded: true },
  { name: "Fresho Toilet Roll (4-pack)", sku: "TISSUE-FRESH-4PK", hsnCode: "4818", category: "CLEANING", gstRate: 18, mrp: 199, sellingPrice: 185, costPrice: 140, unit: "PKT", isBranded: true },
  { name: "Amul Ghee (1 L)", sku: "GHEE-AMUL-1L", hsnCode: "0405", category: "DAIRY", gstRate: 5, mrp: 620, sellingPrice: 595, costPrice: 520, unit: "PCS", isBranded: true },
];

async function main() {
  // ─── HSN Master ────────────────────────────────────────────────────
  console.log("Seeding HSN master table...");
  for (const hsn of hsnCodes) {
    await prisma.hsnMaster.upsert({
      where: { code_description: { code: hsn.code, description: hsn.description } },
      update: { defaultGstRate: hsn.defaultGstRate, isExempt: hsn.isExempt ?? false, category: hsn.category },
      create: { code: hsn.code, description: hsn.description, defaultGstRate: hsn.defaultGstRate, cessRate: 0, isExempt: hsn.isExempt ?? false, category: hsn.category },
    });
  }
  console.log(`  Upserted ${hsnCodes.length} HSN entries.`);

  // ─── Legacy billing products ───────────────────────────────────────
  console.log("Seeding legacy billing products...");
  for (const p of sampleProducts) {
    await prisma.product.upsert({
      where: { sku: p.sku },
      update: { name: p.name },
      create: {
        name: p.name, sku: p.sku, hsnCode: p.hsnCode, category: p.category,
        gstRate: p.gstRate, cessRate: 0, mrp: p.mrp, sellingPrice: p.sellingPrice,
        costPrice: p.costPrice, isTaxInclusive: true, unit: p.unit,
        isExempt: p.isExempt ?? false, isBranded: p.isBranded ?? false,
        currentStock: 100, minStockLevel: 10,
      },
    });
  }
  console.log(`  Upserted ${sampleProducts.length} legacy products.`);

  // ─── Walk-in Customer ──────────────────────────────────────────────
  console.log("Seeding walk-in customer...");
  await prisma.customer.upsert({
    where: { id: "walkin-customer" },
    update: { name: "Walk-in Customer" },
    create: { id: "walkin-customer", name: "Walk-in Customer", phone: "0000000000", customerType: "B2C", paymentTermsDays: 0 },
  });

  // ─── Default Admin User ────────────────────────────────────────────
  console.log("Seeding admin user...");
  const adminPassword = await bcrypt.hash("admin123", 10);
  await prisma.user.upsert({
    where: { email: "admin@company.com" },
    update: {},
    create: { email: "admin@company.com", passwordHash: adminPassword, name: "Admin", role: "OWNER", mustChangePassword: true },
  });
  console.log("  Admin: admin@company.com / admin123");

  // ─── V2: Categories (matching Oneshelf app) ────────────────────────
  console.log("Seeding categories...");
  const categories = [
    { slug: "staples_grains", name: "Staples & Grains", displayOrder: 1 },
    { slug: "dairy", name: "Dairy", displayOrder: 2 },
    { slug: "oils_spices_masalas", name: "Oils, Spices & Masalas", displayOrder: 3 },
    { slug: "beverages", name: "Beverages", displayOrder: 4 },
    { slug: "snacks_namkeen", name: "Snacks & Namkeen", displayOrder: 5 },
    { slug: "packaged_canned", name: "Packaged & Canned Foods", displayOrder: 6 },
    { slug: "bakery_breakfast", name: "Bakery & Breakfast", displayOrder: 7 },
    { slug: "household_personal", name: "Household & Personal Care", displayOrder: 8 },
  ];
  for (const cat of categories) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      update: { name: cat.name, displayOrder: cat.displayOrder },
      create: cat,
    });
  }
  console.log(`  Upserted ${categories.length} categories.`);

  // ─── V2: Catalog Products + Variants ───────────────────────────────
  console.log("Seeding catalog products with variants...");

  const staplesCategory = await prisma.category.findUnique({ where: { slug: "staples_grains" } });
  const dairyCategory = await prisma.category.findUnique({ where: { slug: "dairy" } });
  const oilsCategory = await prisma.category.findUnique({ where: { slug: "oils_spices_masalas" } });
  const snacksCategory = await prisma.category.findUnique({ where: { slug: "snacks_namkeen" } });
  const householdCategory = await prisma.category.findUnique({ where: { slug: "household_personal" } });
  const beveragesCategory = await prisma.category.findUnique({ where: { slug: "beverages" } });

  if (!staplesCategory || !dairyCategory || !oilsCategory || !snacksCategory || !householdCategory || !beveragesCategory) {
    throw new Error("Categories must be seeded first");
  }

  const catalogProducts = [
    {
      handle: "aashirvaad-atta",
      name: "Aashirvaad Atta",
      brand: "Aashirvaad",
      categoryId: staplesCategory.id,
      productType: "PACKAGED" as const,
      description: "Whole wheat atta",
      hsnCode: "1101",
      gstRate: 5,
      isPackaged: true,
      searchKeywords: ["atta", "wheat", "flour", "aashirvaad"],
      variants: [
        { sku: "CAT-AAS-ATT-5KG", packageSize: 5, packageUnit: "KG" as const, mrp: 280, sellingPrice: 265, costPrice: 230, stock: 100, lowStockThreshold: 10 },
        { sku: "CAT-AAS-ATT-10KG", packageSize: 10, packageUnit: "KG" as const, mrp: 550, sellingPrice: 520, costPrice: 450, stock: 50, lowStockThreshold: 5 },
      ],
    },
    {
      handle: "sona-rice-loose",
      name: "Sona Masoori Rice (Loose)",
      brand: null,
      categoryId: staplesCategory.id,
      productType: "LOOSE" as const,
      description: "Loose sona masoori rice",
      hsnCode: "1006",
      gstRate: 0,
      isPackaged: false,
      searchKeywords: ["rice", "sona", "masoori", "loose"],
      variants: [
        { sku: "CAT-RICE-SONA-LOOSE", packageSize: 0.25, packageUnit: "KG" as const, mrp: 70, sellingPrice: 65, costPrice: 55, stock: 500, lowStockThreshold: 50 },
      ],
    },
    {
      handle: "fortune-sunflower-oil",
      name: "Fortune Sunflower Oil",
      brand: "Fortune",
      categoryId: oilsCategory.id,
      productType: "PACKAGED" as const,
      description: "Refined sunflower oil",
      hsnCode: "1512",
      gstRate: 5,
      isPackaged: true,
      searchKeywords: ["oil", "sunflower", "fortune", "cooking"],
      variants: [
        { sku: "CAT-FORT-OIL-1L", packageSize: 1, packageUnit: "LITRE" as const, mrp: 150, sellingPrice: 140, costPrice: 118, stock: 200, lowStockThreshold: 20, bulkMinQty: 12, bulkPrice: 130 },
        { sku: "CAT-FORT-OIL-5L", packageSize: 5, packageUnit: "LITRE" as const, mrp: 720, sellingPrice: 680, costPrice: 580, stock: 50, lowStockThreshold: 5 },
      ],
    },
    {
      handle: "amul-taaza-milk",
      name: "Amul Taaza Milk",
      brand: "Amul",
      categoryId: dairyCategory.id,
      productType: "DAIRY" as const,
      description: "Toned milk tetra pack",
      hsnCode: "0401",
      gstRate: 0,
      isPackaged: true,
      searchKeywords: ["milk", "amul", "taaza", "toned"],
      variants: [
        { sku: "CAT-AMUL-MILK-500ML", packageSize: 500, packageUnit: "ML" as const, mrp: 36, sellingPrice: 35, costPrice: 30, stock: 150, lowStockThreshold: 20 },
        { sku: "CAT-AMUL-MILK-1L", packageSize: 1, packageUnit: "LITRE" as const, mrp: 72, sellingPrice: 70, costPrice: 60, stock: 80, lowStockThreshold: 10 },
      ],
    },
    {
      handle: "parle-g-biscuits",
      name: "Parle-G Biscuits",
      brand: "Parle",
      categoryId: snacksCategory.id,
      productType: "PACKAGED" as const,
      description: "Glucose biscuits",
      hsnCode: "1905",
      gstRate: 5,
      isPackaged: true,
      searchKeywords: ["biscuit", "parle", "glucose"],
      variants: [
        { sku: "CAT-PARLE-G-250G", packageSize: 250, packageUnit: "GRAM" as const, mrp: 25, sellingPrice: 25, costPrice: 20, stock: 300, lowStockThreshold: 30 },
        { sku: "CAT-PARLE-G-800G", packageSize: 800, packageUnit: "GRAM" as const, mrp: 80, sellingPrice: 76, costPrice: 62, stock: 100, lowStockThreshold: 10 },
      ],
    },
    {
      handle: "surf-excel",
      name: "Surf Excel Detergent",
      brand: "Surf Excel",
      categoryId: householdCategory.id,
      productType: "PACKAGED" as const,
      description: "Washing powder detergent",
      hsnCode: "3401",
      gstRate: 5,
      isPackaged: true,
      searchKeywords: ["detergent", "surf", "washing", "powder"],
      variants: [
        { sku: "CAT-SURF-1KG", packageSize: 1, packageUnit: "KG" as const, mrp: 185, sellingPrice: 175, costPrice: 148, stock: 80, lowStockThreshold: 10 },
      ],
    },
    {
      handle: "coca-cola",
      name: "Coca-Cola",
      brand: "Coca-Cola",
      categoryId: beveragesCategory.id,
      productType: "PACKAGED" as const,
      description: "Carbonated soft drink",
      hsnCode: "2202",
      gstRate: 40,
      isPackaged: true,
      searchKeywords: ["coke", "cola", "soft drink", "aerated"],
      variants: [
        { sku: "CAT-COKE-750ML", packageSize: 750, packageUnit: "ML" as const, mrp: 40, sellingPrice: 40, costPrice: 30, stock: 200, lowStockThreshold: 20 },
        { sku: "CAT-COKE-2L", packageSize: 2, packageUnit: "LITRE" as const, mrp: 96, sellingPrice: 90, costPrice: 72, stock: 60, lowStockThreshold: 10 },
      ],
    },
  ];

  for (const cp of catalogProducts) {
    const { variants, ...productData } = cp;
    const product = await prisma.catalogProduct.upsert({
      where: { handle: productData.handle },
      update: { name: productData.name },
      create: productData,
    });
    for (const v of variants) {
      await prisma.productVariant.upsert({
        where: { sku: v.sku },
        update: { mrp: v.mrp, sellingPrice: v.sellingPrice, stock: v.stock },
        create: { ...v, productId: product.id },
      });
    }
  }
  console.log(`  Upserted ${catalogProducts.length} catalog products with variants.`);

  // ─── V2: Store Config ──────────────────────────────────────────────
  console.log("Seeding store config...");
  const existing = await prisma.storeConfig.findFirst();
  if (!existing) {
    await prisma.storeConfig.create({
      data: {
        storeName: "Oneshelf",
        storeAddress: "123 Main Street, Your City",
        storePhone: "9876543210",
        storeEmail: "store@oneshelf.in",
        legalName: "Oneshelf Retail Pvt Ltd",
        deliveryDateLabel: "Today",
        freeDeliveryAbove: 500,
        isOrderingAllowed: true,
        operatingHoursStart: "08:00",
        operatingHoursEnd: "22:00",
      },
    });
  }
  console.log("  Store config ready.");

  // ─── V2: Sample Banners ────────────────────────────────────────────
  console.log("Seeding banners...");
  const banners = [
    { imageUrl: "https://via.placeholder.com/800x300/2E7D32/FFFFFF?text=Fresh+Vegetables+Daily", targetCategory: "staples_grains", displayOrder: 1 },
    { imageUrl: "https://via.placeholder.com/800x300/1565C0/FFFFFF?text=Dairy+Deals+This+Week", targetCategory: "dairy", displayOrder: 2 },
    { imageUrl: "https://via.placeholder.com/800x300/E65100/FFFFFF?text=Free+Delivery+Above+500", displayOrder: 3 },
  ];
  for (const b of banners) {
    const existing = await prisma.banner.findFirst({ where: { imageUrl: b.imageUrl } });
    if (!existing) {
      await prisma.banner.create({ data: b });
    }
  }
  console.log(`  Seeded ${banners.length} banners.`);

  // ─── V2: Sample Coupons ────────────────────────────────────────────
  console.log("Seeding coupons...");
  const coupons = [
    { code: "WELCOME10", couponType: "PERCENT" as const, value: 10, minOrder: 200, maxDiscount: 50, description: "10% off on first order (max ₹50)" },
    { code: "FLAT50", couponType: "FLAT" as const, value: 50, minOrder: 500, description: "Flat ₹50 off on orders above ₹500" },
    { code: "FREEDEL", couponType: "FREE_DELIVERY" as const, value: 0, minOrder: 0, description: "Free delivery on any order" },
  ];
  for (const c of coupons) {
    await prisma.coupon.upsert({
      where: { code: c.code },
      update: { description: c.description },
      create: c,
    });
  }
  console.log(`  Upserted ${coupons.length} coupons.`);

  console.log("\nSeeding complete.");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
