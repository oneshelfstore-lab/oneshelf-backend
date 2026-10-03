// Health & Wellness: 10 categories → children → grandchildren, as supplied, plus light per-category product fields.
// Loaded by scripts/seedTree.ts (see data/catalogTrees.ts).
//
// ⚠️ "Medicines & OTC" is here as supplied, but nothing yet limits it to sellers holding a drug licence: every seller
// who ticked the Health department sees it (data/superCategories.ts). Licensing is only collected at onboarding
// (the PHARMACY extra step in shopTypes.ts). Gate the category on that before real sellers go live.
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const form = (...options: string[]) => pick("form", "Form", options, { filterable: true, showOnCard: true });
const count = num("count", "Count", { showOnCard: true });
const warranty = t("warranty", "Warranty", { showOnCard: true });

export const HEALTH: Root[] = [
  {
    n: "Medicines & OTC",
    f: [t("composition", "Composition / salt", { showOnCard: true }), form("Tablet", "Capsule", "Syrup", "Gel", "Spray", "Drops", "Cream", "Ointment", "Powder", "Lozenge")],
    k: [
      k("Pain Relief", "Pain Relief Tablets", "Pain Relief Capsules", "Pain Relief Gel", "Pain Relief Spray", "Pain Relief Balm"),
      k("Cold & Cough", "Cough Syrup", "Cough Drops", "Cold Tablets", "Nasal Drops", "Throat Lozenges"),
      k("Digestive Health", "Antacid", "Digestive Tablets", "ORS", "Laxative", "Oral Rehydration Products"),
      k("Allergy Relief", "Allergy Tablets", "Anti-Allergy Syrup", "Nasal Spray", "Eye Drops"),
      k("Topical Treatments", "Antiseptic Cream", "Antiseptic Liquid", "Burn Cream", "Wound Cream", "Medicated Ointment"),
    ],
  },
  {
    n: "Vitamins & Supplements",
    f: [form("Tablet", "Capsule", "Powder", "Gummies", "Syrup", "Bar"), count, pick("suitable_for", "Suitable for", ["Adults", "Men", "Women", "Kids", "Seniors"], { filterable: true }), yn("vegetarian", "Vegetarian", { filterable: true })],
    k: [
      k("Vitamins", "Multivitamins", "Vitamin C", "Vitamin D", "Vitamin B Complex", "Vitamin E"),
      k("Minerals", "Calcium", "Iron", "Magnesium", "Zinc", "Potassium"),
      k("Protein & Nutrition", "Protein Powder", "Protein Bars", "Nutrition Powder", "Meal Replacement"),
      k("Specialty Supplements", "Omega-3", "Probiotics", "Electrolytes", "Fiber Supplements", "Herbal Supplements"),
      k("Ayurvedic Supplements", "Herbal Tablets", "Herbal Powder", "Herbal Syrup", "Herbal Capsules"),
    ],
  },
  {
    n: "First Aid", f: [num("pack_count", "Pieces in pack", { showOnCard: true })],
    k: [
      k("Wound Care", "Adhesive Bandage", "Sterile Gauze", "Cotton Roll", "Medical Tape", "Wound Dressing"),
      k("Antiseptics", "Antiseptic Liquid", "Antiseptic Cream", "Antiseptic Spray"),
      { ...k("Support & Immobilization", "Elastic Bandage", "Crepe Bandage", "Wrist Support", "Knee Support", "Ankle Support"), f: [pick("size", "Size", ["S", "M", "L", "XL", "Free size"], { filterable: true, showOnCard: true })] },
      k("First Aid Kits", "Basic First Aid Kit", "Travel First Aid Kit", "Family First Aid Kit"),
    ],
  },
  {
    n: "Medical Devices", f: [warranty],
    k: [
      k("Monitoring Devices", "Digital Thermometer", "Pulse Oximeter", "Blood Pressure Monitor", "Blood Glucose Monitor", "Weighing Scale"),
      k("Diabetes Care", "Glucose Meter", "Glucose Test Strips", "Lancets", "Insulin Accessories"),
      k("Respiratory Care", "Nebulizer", "Steam Inhaler", "Spacer", "Respiratory Accessories"),
      k("Medical Accessories", "Hot Water Bag", "Ice Pack", "Heating Pad", "Pill Box"),
    ],
  },
  {
    n: "Personal Health Care",
    k: [
      k("Eye Care", "Lubricating Eye Drops", "Eye Wash", "Eye Mask", "Eye Care Accessories"),
      k("Ear Care", "Ear Drops", "Ear Plugs", "Ear Care Accessories"),
      k("Foot Care", "Corn Caps", "Foot Cream", "Heel Protectors", "Foot Support"),
      k("Oral Health", "Mouthwash", "Dental Floss", "Oral Gel", "Denture Care"),
    ],
  },
  {
    n: "Women's Health",
    k: [
      k("Pregnancy Care", "Pregnancy Test Kit", "Pregnancy Supplements", "Maternity Support"),
      k("Fertility & Ovulation", "Ovulation Test Kit", "Fertility Test Kit"),
      k("Menstrual Health", "Menstrual Pain Relief", "Menstrual Health Supplements"),
      k("Breast Care", "Breast Pads", "Nipple Care", "Breast Support"),
    ],
  },
  {
    n: "Men's Health",
    k: [
      k("Men's Supplements", "Men's Multivitamin", "Men's Wellness Supplements", "Men's Herbal Supplements"),
      k("Sexual Wellness", "Condoms", "Lubricants", "Sexual Wellness Products"),
      k("Men's Health Tests", "Health Test Kits", "Diagnostic Test Kits"),
    ],
  },
  {
    n: "Baby Health", f: [pick("age_group", "Age group", ["0-6 months", "6-12 months", "1-3 years", "3+ years"], { filterable: true, showOnCard: true })],
    k: [
      k("Baby Medicines", "Baby Fever Relief", "Baby Cold Relief", "Baby Digestive Care"),
      k("Baby Supplements", "Baby Vitamins", "Baby Iron Supplements", "Baby Probiotics"),
      k("Baby Medical Care", "Baby Thermometer", "Baby Nasal Care", "Baby First Aid"),
    ],
  },
  {
    n: "Health Tests & Diagnostics", f: [num("tests_in_kit", "Tests in kit", { showOnCard: true })],
    k: [
      k("Home Test Kits", "Pregnancy Test", "Ovulation Test", "COVID Test", "Infection Test"),
      k("Diabetes Tests", "Glucose Test Strip", "Ketone Test", "HbA1c Test Kit"),
      k("General Tests", "Cholesterol Test", "Hemoglobin Test", "Urine Test Kit"),
    ],
  },
  {
    n: "Wellness & Alternative Health",
    k: [
      k("Ayurvedic Care", "Ayurvedic Oil", "Ayurvedic Balm", "Herbal Powder", "Herbal Tea"),
      k("Aromatherapy", "Essential Oil", "Massage Oil", "Aromatherapy Accessories"),
      k("Sleep & Relaxation", "Sleep Aid Products", "Eye Mask", "Ear Plugs", "Relaxation Products"),
      k("Wellness Accessories", "Massage Ball", "Acupressure Products", "Posture Support", "Wellness Kits"),
    ],
  },
];

/** Existing products that belong in this tree (exact name or subcategory, within the `from` root). */
export const HEALTH_MOVES: { name?: string; subcategory?: string; from: string; path: string[] }[] = [
  { subcategory: "ayurvedic herbs", from: "herbs_ayurvedic_products", path: ["Vitamins & Supplements", "Ayurvedic Supplements"] },
];
