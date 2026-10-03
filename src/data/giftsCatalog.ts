// Gifts & Lifestyle: 11 categories → children → grandchildren. Occasion, recipient, age group, personalisation and
// gifting suitability are product FIELDS (and Collections for seasonal shelves), not category levels — so the supplied
// "Gifts for Occasions" and "Gifts for Relationships" children and "Spiritual & Festive > Festival Gifts" are NOT
// categories here (festival shelves like Diwali/Rakhi are Collections the admin fills). Loaded by scripts/seedTree.ts.
//
// Overlaps with live trees, kept as supplied (each under its own parent; decide later which side keeps them): Candles /
// Decorative Showpiece / Figurine / Tray vs Home & Kitchen > Home Decor; Hair Accessories vs Personal Care; Eye Mask /
// Essential Oil vs Health; Collectible Figure / Model Kit vs Toys; Lanyard / ID Card Holder vs Stationery > Miscellaneous;
// Wrapping Paper & Ribbon vs Stationery > Envelopes & Packaging; Pooja items vs the existing Spiritual & Pooja category.
import type { Root } from "./stationeryCatalog.js";
import { leaves, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const occasion = pick("occasion", "Occasion", ["Birthday", "Anniversary", "Wedding", "Housewarming", "Graduation", "Festival", "Corporate", "Any occasion"], { filterable: true, showOnCard: true });
const recipient = pick("recipient", "Recipient", ["Couple", "Friend", "Parent", "Child", "Colleague", "Men", "Women", "Anyone"], { filterable: true });
const personalised = yn("personalisable", "Can be personalised", { filterable: true });
const colour = t("colour", "Colour", { filterable: true });
const material = t("material", "Material", { filterable: true });
const fragrance = t("fragrance", "Fragrance", { showOnCard: true });
const giftFields = [occasion, recipient, personalised];

export const GIFTS: Root[] = [
  {
    n: "Gifts", f: giftFields,
    k: [
      k("Gift Sets", "Gift Hamper", "Personalized Gift Set", "Couple Gift Set", "Corporate Gift Set"),
      k("Personalized Gifts", "Personalized Mug", "Personalized Frame", "Personalized Keychain", "Personalized Cushion", "Personalized Photo Gift"),
    ],
  },
  {
    n: "Flowers & Gifting", f: [occasion, recipient],
    k: [
      k("Fresh Flowers", "Rose Bouquet", "Mixed Flower Bouquet", "Lily Bouquet", "Flower Arrangement"),
      k("Artificial Flowers", "Artificial Bouquet", "Artificial Flower Arrangement", "Decorative Flowers"),
      k("Floral Gifts", "Flower & Gift Combo", "Flower Box", "Preserved Flowers"),
    ],
  },
  {
    n: "Cards & Greeting", f: [occasion],
    k: [
      k("Greeting Cards", "Birthday Card", "Anniversary Card", "Wedding Card", "Thank You Card", "Congratulations Card"),
      k("Occasion Cards", "Valentine's Day Card", "Mother's Day Card", "Father's Day Card", "Friendship Card"),
      k("Stationery Gifts", "Gift Envelope", "Gift Tag", "Greeting Card Set"),
    ],
  },
  {
    n: "Home Lifestyle", f: [colour, material],
    k: [
      k("Decorative Lifestyle", "Decorative Showpiece", "Figurine", "Decorative Tray", "Decorative Box"),
      { ...k("Candles", "Scented Candle", "Decorative Candle", "Candle Gift Set", "Candle Holder"), f: [fragrance] },
      { ...k("Fragrance", "Reed Diffuser", "Aroma Diffuser", "Potpourri", "Fragrance Gift Set"), f: [fragrance] },
    ],
  },
  {
    n: "Lifestyle Accessories", f: [colour, material, personalised],
    k: [
      k("Keychains", "Metal Keychain", "Leather Keychain", "Personalized Keychain", "Character Keychain"),
      k("Wallets & Card Holders", "Wallet", "Card Holder", "Coin Pouch"),
      k("Travel Accessories", "Passport Holder", "Luggage Tag", "Travel Organizer", "Travel Pouch"),
      k("Everyday Accessories", "Compact Mirror", "Accessory Pouch", "Lanyard", "ID Card Holder"),
    ],
  },
  {
    n: "Watches & Fashion Lifestyle", f: [pick("for_whom", "For", ["Men", "Women", "Unisex", "Kids"], { filterable: true, showOnCard: true }), colour],
    k: [
      { ...k("Watches", "Analog Watch", "Digital Watch", "Fashion Watch"), f: [pick("strap", "Strap", ["Leather", "Metal", "Silicone", "Fabric"], { filterable: true }), t("dial_colour", "Dial colour"), t("warranty", "Warranty")] },
      k("Fashion Accessories", "Sunglasses", "Belt", "Scarf", "Fashion Jewellery"),
      k("Lifestyle Accessories", "Hair Accessories", "Bag Charm", "Brooch"),
    ],
  },
  {
    n: "Spiritual & Festive", f: [material],
    k: [
      k("Pooja & Spiritual", "Pooja Thali", "Diya", "Incense Holder", "Spiritual Idol", "Pooja Gift Set"),
      k("Festive Decorations", "Toran", "Rangoli Decoration", "Festival Decoration", "Decorative Lights"),
    ],
  },
  {
    n: "Party & Celebration", f: [occasion, t("pack_count", "Pieces in pack", { showOnCard: true })],
    k: [
      k("Party Decorations", "Balloons", "Banner", "Party Backdrop", "Table Decoration"),
      k("Celebration Accessories", "Cake Topper", "Party Hat", "Party Props", "Confetti"),
      k("Party Supplies", "Return Gift", "Party Favour", "Celebration Kit"),
    ],
  },
  {
    n: "Hobbies & Collectibles", f: [pick("age_group", "Age group", ["Kids", "Teens", "Adults", "All ages"], { filterable: true })],
    k: [
      k("Collectibles", "Collectible Figure", "Souvenir", "Memorabilia", "Miniature"),
      k("Hobby Products", "Model Kit", "DIY Hobby Kit", "Craft Hobby Kit", "Collection Album"),
      k("Souvenirs", "Travel Souvenir", "City Souvenir", "Cultural Souvenir"),
    ],
  },
  {
    n: "Lifestyle Wellness", f: [recipient, occasion],
    k: [
      k("Relaxation", "Eye Mask", "Relaxation Gift Set", "Meditation Accessories"),
      { ...k("Aromatherapy", "Essential Oil", "Aroma Diffuser", "Aromatherapy Gift Set"), f: [fragrance] },
      k("Wellness Gifts", "Self-Care Gift Set", "Wellness Hamper", "Meditation Gift Set"),
    ],
  },
  {
    n: "Gift Packaging", f: [colour, occasion],
    k: [
      k("Gift Boxes", "Gift Box", "Magnetic Gift Box", "Wooden Gift Box", "Gift Box Set"),
      k("Gift Bags", "Paper Gift Bag", "Fabric Gift Bag", "Premium Gift Bag"),
      k("Gift Wrapping", "Wrapping Paper", "Ribbon", "Gift Bow", "Gift Wrapping Set"),
    ],
  },
];
