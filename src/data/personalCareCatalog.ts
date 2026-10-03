// Personal Care & Beauty: 16 categories → children → grandchildren, as supplied, plus light per-category product
// fields. Loaded by scripts/seedTree.ts (see data/catalogTrees.ts).
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const suitableFor = pick("suitable_for", "Suitable for", ["Men", "Women", "Unisex", "Kids"], { filterable: true });
const skinType = pick("skin_type", "Skin type", ["All skin types", "Oily", "Dry", "Combination", "Sensitive"], { filterable: true, showOnCard: true });
const hairType = pick("hair_type", "Hair type", ["All hair types", "Dry", "Oily", "Normal", "Curly", "Damaged"], { filterable: true, showOnCard: true });
const shade = t("shade", "Shade", { showOnCard: true });
const packCount = num("pack_count", "Pieces in pack");

export const PERSONAL_CARE: Root[] = [
  {
    n: "Skin Care", f: [skinType, suitableFor],
    k: [
      k("Face Care", "Face Wash", "Cleansers", "Toners", "Face Serums", "Moisturizers", "Face Creams", "Face Oils", "Face Masks", "Face Scrubs", "Acne & Spot Care"),
      { ...k("Sun Care", "Sunscreen", "Sunscreen Gel", "Sunscreen Lotion", "Sunscreen Stick", "After-Sun Care"), f: [num("spf", "SPF", { filterable: true, showOnCard: true })] },
      k("Lip Care", "Lip Balm", "Lip Scrub", "Lip Mask", "Lip Treatment"),
      k("Body Care", "Body Lotion", "Body Cream", "Body Butter", "Body Oil", "Body Scrub", "Hand Cream", "Foot Care"),
    ],
  },
  {
    n: "Hair Care", f: [hairType, suitableFor],
    k: [
      k("Shampoo", "Anti-Dandruff", "Anti-Hair Fall", "Moisturizing", "Herbal", "Kids"),
      k("Conditioner", "Regular Conditioner", "Deep Conditioner", "Leave-In Conditioner"),
      k("Hair Oil", "Coconut Oil", "Amla Oil", "Almond Oil", "Onion Oil", "Herbal Oil"),
      k("Hair Treatment", "Hair Mask", "Hair Serum", "Anti-Frizz", "Hair Spa"),
      k("Hair Styling", "Hair Gel", "Hair Wax", "Hair Cream", "Hair Mousse", "Hair Spray", "Styling Powder"),
    ],
  },
  {
    n: "Hair Color", f: [shade, yn("ammonia_free", "Ammonia free", { filterable: true })],
    k: leaves("Permanent Hair Color", "Semi-Permanent Color", "Temporary Color", "Root Touch-Up", "Henna", "Hair Bleach", "Developer", "Beard Color"),
  },
  { n: "Bath & Body", f: [suitableFor, t("fragrance", "Fragrance")], k: leaves("Bath Soap", "Body Wash", "Shower Gel", "Bath Scrubs", "Bath Salts", "Bath Sponges", "Loofahs", "Body Brushes") },
  {
    n: "Oral Care", f: [t("flavour", "Flavour")],
    k: [k("Toothpaste", "Regular", "Whitening", "Sensitive", "Herbal"), k("Toothbrush", "Manual", "Electric", "Kids"), k("Mouthwash"), k("Dental Floss"), k("Tongue Cleaners"), k("Breath Fresheners")],
  },
  {
    n: "Deodorants & Fragrance", f: [suitableFor, t("fragrance", "Fragrance", { showOnCard: true })],
    k: [k("Deodorant", "Spray", "Roll-On", "Stick"), k("Perfume", "Eau de Parfum", "Eau de Toilette", "Attar"), k("Body Mist"), k("Body Spray"), k("Pocket Perfume")],
  },
  {
    n: "Makeup", f: [shade],
    k: [
      k("Face Makeup", "Foundation", "Concealer", "BB Cream", "CC Cream", "Compact", "Loose Powder", "Blush", "Bronzer", "Contour", "Highlighter", "Primer"),
      k("Eye Makeup", "Kajal", "Eyeliner", "Mascara", "Eyeshadow", "Eyebrow Pencil", "False Eyelashes"),
      k("Lip Makeup", "Lipstick", "Liquid Lipstick", "Lip Gloss", "Lip Liner", "Lip Tint", "Lip Crayon"),
    ],
  },
  { n: "Nail Care", f: [shade], k: leaves("Nail Polish", "Gel Nail Polish", "Nail Polish Remover", "Nail Treatment", "Nail File", "Nail Buffer", "False Nails", "Nail Glue", "Nail Art") },
  {
    n: "Men's Grooming",
    k: [
      k("Beard Care", "Beard Oil", "Beard Balm", "Beard Wax", "Beard Wash"),
      k("Shaving", "Razors", "Shaving Cream", "Shaving Foam", "Shaving Gel", "Aftershave"),
      { ...k("Men's Skin Care", "Face Wash", "Moisturizer", "Sunscreen", "Face Scrub"), f: [skinType] },
    ],
  },
  {
    n: "Feminine Care", f: [packCount, pick("pad_size", "Size", ["Regular", "Large", "XL", "XXL"], { filterable: true })],
    k: leaves("Sanitary Pads", "Panty Liners", "Tampons", "Menstrual Cups", "Intimate Wash", "Feminine Hygiene Wipes"),
  },
  { n: "Hair Removal", k: leaves("Disposable Razors", "Facial Razors", "Wax Strips", "Wax", "Depilatory Cream", "Threading Products") },
  { n: "Beauty Tools & Accessories", k: leaves("Makeup Brushes", "Makeup Sponges", "Eyelash Curlers", "Tweezers", "Makeup Mirrors", "Facial Rollers", "Gua Sha", "Face Cleansing Tools", "Cosmetic Sharpeners") },
  { n: "Hair Accessories", f: [t("colour", "Colour", { filterable: true }), packCount], k: leaves("Hair Bands", "Scrunchies", "Hair Clips", "Claw Clips", "Hair Pins", "Headbands", "Hair Rollers", "Hair Extensions") },
  { n: "Beauty Storage", k: leaves("Makeup Bags", "Cosmetic Pouches", "Makeup Organizers", "Brush Holders", "Travel Cosmetic Cases") },
  { n: "Baby Personal Care", k: leaves("Baby Soap", "Baby Shampoo", "Baby Lotion", "Baby Oil", "Baby Powder", "Baby Wipes", "Diaper Rash Cream") },
  { n: "Beauty & Grooming Kits", k: leaves("Makeup Kits", "Skincare Kits", "Haircare Kits", "Grooming Kits", "Bath Kits", "Travel Kits") },
];

/**
 * Existing products that belong in this tree. Match by exact `name` or by free-text `subcategory` within the `from`
 * root; `path` is the target node (a non-leaf is fine — the product then sits at that level).
 * Cleaning lines of `household_personal` (washing powder, dishwash, batteries…) deliberately stay for the Cleaning tree.
 */
export const PERSONAL_CARE_MOVES: { name?: string; subcategory?: string; from: string; path: string[] }[] = [
  { subcategory: "Facewash", from: "beauty", path: ["Skin Care", "Face Care", "Face Wash"] },
  { subcategory: "Shampoo", from: "beauty", path: ["Hair Care", "Shampoo"] },
  { subcategory: "Powder", from: "beauty", path: ["Skin Care", "Body Care"] },
  { subcategory: "Blade & Shaving cream", from: "beauty", path: ["Men's Grooming", "Shaving"] },
  { name: "Fair Lovely Cream", from: "beauty", path: ["Skin Care", "Face Care", "Face Creams"] },
  { subcategory: "Hair Care", from: "household_personal", path: ["Hair Care", "Hair Oil"] },
  { subcategory: "Shampoo", from: "household_personal", path: ["Hair Care", "Shampoo"] },
  { subcategory: "Sanitary & Hygiene", from: "household_personal", path: ["Feminine Care"] },
  { subcategory: "Skin Care", from: "household_personal", path: ["Skin Care"] },
  { subcategory: "Facewash", from: "household_personal", path: ["Skin Care", "Face Care", "Face Wash"] },
  { subcategory: "Blade & Shaving cream", from: "household_personal", path: ["Men's Grooming", "Shaving"] },
  { subcategory: "Soaps & Body Wash", from: "household_personal", path: ["Bath & Body"] },
  { subcategory: "Toothpaste & Toothbrush", from: "household_personal", path: ["Oral Care"] },
];
