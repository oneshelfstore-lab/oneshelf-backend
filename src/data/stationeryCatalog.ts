// Stationery category tree + per-category product fields. Pure data, loaded by scripts/seedStationery.ts.
//
//   Super → Category (root) → Child → Grandchild      (Category.parentId nesting, see services/categoryTree.ts)
//
// Rules the tree follows: each product lives in ONE place; specs (pencil grade, notebook ruling, paper size) are
// FIELDS not categories; a grandchild exists only where a group has 4+ things shoppers browse separately.
// `f` = fields this node ADDS; every node below inherits them (services/categoryFields.ts).

import type { FieldDef } from "../services/categoryFields.js";

export type Node = { n: string; f?: FieldDef[]; k?: Node[] };
export type Root = Node & { img?: string };
export type Super = { slug: string; name: string; roots: Root[] };

const t = (key: string, label: string, o: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: "TEXT", ...o });
const num = (key: string, label: string, o: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: "NUMBER", ...o });
const pick = (key: string, label: string, options: string[], o: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: "CHOICE", options, ...o });
const yn = (key: string, label: string, o: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: "BOOLEAN", ...o });
const packOf = num("pack_of", "Pack of", { showOnCard: true });
const colour = t("colour", "Colour", { filterable: true, showOnCard: true });
const sizeA = pick("size", "Size", ["A3", "A4", "A5", "A6", "Legal", "Letter", "Other"], { filterable: true, showOnCard: true });
const leaves = (...names: string[]): Node[] => names.map((n) => ({ n }));
const withF = (n: string, f: FieldDef[], k?: string[]): Node => ({ n, f, k: k ? leaves(...k) : undefined });

export const STATIONERY: Super[] = [
  {
    slug: "stationery_school_writing",
    name: "School & Writing",
    roots: [
      {
        n: "Pens & Markers",
        f: [colour, pick("tip_size", "Tip size", ["0.3", "0.5", "0.7", "1.0", "Other"], { unit: "mm", filterable: true, showOnCard: true }), packOf],
        k: [
          withF("Ball pens", [pick("ink_type", "Ink type", ["Ball", "Oil-based"])]),
          withF("Gel pens", [yn("refillable", "Refillable", { filterable: true })]),
          { n: "Roller pens", f: [yn("refillable", "Refillable", { filterable: true })] },
          withF("Fountain pens", [pick("nib", "Nib", ["Fine", "Medium", "Broad", "Calligraphy"], { filterable: true })]),
          { n: "Fineliner & technical pens" },
          { n: "Highlighters" },
          { n: "Markers", k: leaves("Permanent", "Whiteboard", "CD / OHP", "Paint") },
          { n: "Calligraphy & brush pens" },
          { n: "Stylus pens" },
          { n: "Correction", k: leaves("Correction pens", "Correction fluid", "Correction tape") },
          { n: "Refills & ink", k: leaves("Pen refills", "Fountain pen ink") },
        ],
      },
      {
        n: "Pencils & Erasers",
        f: [packOf],
        k: [
          withF("Wooden pencils", [pick("grade", "Grade", ["HB", "2B", "4B", "6B", "8B", "2H", "Other"], { filterable: true, showOnCard: true }), pick("shape", "Shape", ["Round", "Triangular", "Jumbo"])]),
          withF("Mechanical pencils", [pick("lead_size", "Lead size", ["0.3", "0.5", "0.7", "0.9", "2.0"], { unit: "mm", filterable: true })]),
          withF("Lead refills", [pick("lead_size", "Lead size", ["0.3", "0.5", "0.7", "0.9", "2.0"], { unit: "mm", filterable: true }), pick("grade", "Grade", ["HB", "2B", "Other"])]),
          { n: "Sharpeners", k: leaves("Manual", "Electric") },
          { n: "Erasers", k: leaves("Pencil erasers", "Ink erasers", "Kneaded erasers") },
          { n: "Pencil accessories" },
        ],
      },
      {
        n: "Notebooks & Paper",
        k: [
          {
            n: "Notebooks",
            f: [
              num("pages", "Pages", { filterable: true, showOnCard: true }),
              pick("ruling", "Ruling", ["Single line", "Double line", "Four line", "Square", "Plain", "Graph"], { filterable: true, showOnCard: true }),
              pick("binding", "Binding", ["Spiral", "Hardbound", "Softbound", "Stitched"], { filterable: true }),
              sizeA, num("gsm", "Paper weight", { unit: "GSM" }), packOf,
            ],
            k: leaves("Spiral", "Hardbound", "Softbound & long", "Practical & lab", "Drawing books", "Pocket", "Rough"),
          },
          { n: "Pads & notes", f: [sizeA, num("sheets", "Sheets"), packOf], k: leaves("Memo & notepads", "Sticky notes") },
          { n: "Cards", f: [num("count", "Cards in pack")], k: leaves("Index cards", "Flash cards") },
          {
            n: "Loose paper",
            f: [sizeA, num("gsm", "Paper weight", { unit: "GSM", filterable: true }), num("sheets", "Sheets in pack", { showOnCard: true })],
            k: leaves("Plain & ruled", "Graph", "Tracing & butter", "Carbon", "Coloured"),
          },
        ],
      },
      {
        n: "School Essentials",
        k: [
          withF("School bags", [num("capacity", "Capacity", { unit: "L", filterable: true }), t("colour", "Colour", { filterable: true })]),
          withF("Lunch boxes & bottles", [num("capacity", "Capacity", { unit: "ml", filterable: true, showOnCard: true }), pick("material", "Material", ["Plastic", "Steel", "Glass", "Silicone"], { filterable: true })]),
          { n: "Pencil boxes" },
          { n: "Covers & labels" },
          { n: "Diaries & timetables" },
          { n: "Boards", k: leaves("Exam boards", "Slate boards", "Writing boards") },
          { n: "Chalk & dusters" },
        ],
      },
      {
        n: "Geometry & Drafting",
        k: [
          { n: "Geometry boxes" },
          withF("Rulers & scales", [num("length", "Length", { unit: "cm", filterable: true }), pick("material", "Material", ["Plastic", "Steel", "Wood"], { filterable: true })]),
          { n: "Set squares & protractors" },
          { n: "Compasses & dividers" },
          { n: "Measuring tapes" },
          { n: "Drafting", k: leaves("Boards & mini drafters", "T-squares", "Templates & French curves", "Drafting tape") },
        ],
      },
    ],
  },
  {
    slug: "stationery_art_craft",
    name: "Art & Craft",
    roots: [
      {
        n: "Colours & Painting",
        f: [packOf, num("shades", "Shades", { showOnCard: true })],
        k: [
          { n: "Crayons" },
          { n: "Pastels", k: leaves("Oil pastels", "Soft pastels") },
          { n: "Colour pencils" },
          { n: "Sketch pens" },
          { n: "Paints", k: leaves("Watercolour", "Poster", "Acrylic", "Fabric", "Glass") },
          { n: "Brushes" },
          { n: "Palettes" },
          { n: "Drawing ink" },
        ],
      },
      {
        n: "Drawing & Artist Supplies",
        k: [
          withF("Sketchbooks & drawing sheets", [sizeA, num("gsm", "Paper weight", { unit: "GSM", filterable: true }), num("sheets", "Sheets")]),
          { n: "Canvas & canvas boards" },
          { n: "Easels" },
          { n: "Charcoal & graphite" },
          { n: "Palette knives" },
          { n: "Fixatives & masking fluid" },
          { n: "Art & colouring books" },
        ],
      },
      {
        n: "Craft Supplies",
        k: [
          { n: "Craft paper", f: [sizeA, colour, num("sheets", "Sheets in pack")], k: leaves("Origami", "Crepe", "Tissue", "Chart paper", "Mount board", "Glitter sheets") },
          { n: "Foam, EVA & felt sheets", f: [colour, packOf] },
          { n: "Craft sticks & wire" },
          { n: "Decor", k: leaves("Glitter", "Beads & sequins", "Googly eyes", "Pipe cleaners", "Ribbons", "Stickers") },
          { n: "Clay & dough", f: [colour, num("weight", "Weight", { unit: "g" })] },
          { n: "Craft kits" },
        ],
      },
      {
        n: "Adhesives & Tapes",
        k: [
          { n: "Glue", f: [num("quantity", "Quantity", { unit: "g", showOnCard: true })], k: leaves("White glue (Fevicol)", "Liquid glue", "Super glue", "Rubber cement", "Spray adhesive") },
          withF("Glue sticks", [num("quantity", "Quantity", { unit: "g", showOnCard: true })]),
          { n: "Mounting (glue dots, hooks)" },
          {
            n: "Tapes",
            f: [num("width", "Width", { unit: "mm", filterable: true }), num("length", "Length", { unit: "m", showOnCard: true })],
            k: leaves("Transparent", "Double-sided", "Masking", "Paper", "Foam", "Decorative", "Packaging"),
          },
        ],
      },
      {
        n: "Cutting Tools",
        k: [
          withF("Scissors", [pick("type", "Type", ["Office", "Craft", "Kids"], { filterable: true }), pick("material", "Blade", ["Steel", "Stainless steel"])]),
          { n: "Cutters & knives" },
          { n: "Blades" },
          { n: "Trimmers & guillotines" },
        ],
      },
    ],
  },
  {
    slug: "stationery_office_business",
    name: "Office & Business",
    roots: [
      {
        n: "Files & Storage",
        f: [sizeA, colour],
        k: leaves("Folders", "Button & clip files", "Ring & lever-arch files", "Display & expanding files", "Box files & racks", "Document bags & pockets", "Sheet protectors & dividers", "Certificate holders"),
      },
      {
        n: "Desk Accessories",
        k: [
          { n: "Staplers & staples" },
          withF("Clips", [pick("type", "Type", ["Paper clip", "Binder clip", "Bulldog clip"], { filterable: true }), packOf]),
          { n: "Pins" },
          { n: "Rubber bands" },
          { n: "Organisers & trays" },
          { n: "Pen & pencil stands" },
          { n: "Paperweights" },
          { n: "Tape dispensers" },
        ],
      },
      {
        n: "Forms, Registers & Stamps",
        k: [
          { n: "Registers", f: [num("pages", "Pages", { filterable: true }), sizeA], k: leaves("Cash books", "Ledger books", "Stock registers", "Attendance registers", "Visitor registers") },
          { n: "Bill & receipt books", f: [num("pages", "Pages"), pick("copies", "Copies", ["Single", "Duplicate", "Triplicate"], { filterable: true })], k: leaves("Bill books", "Receipt books", "Invoice books", "Order books", "Voucher books & challans") },
          { n: "Rubber stamps", k: leaves("Self-inking", "Date & number", "Stamp pads & ink") },
        ],
      },
      {
        n: "Labels & Stickers",
        f: [num("count", "Labels in pack"), packOf],
        k: leaves("Address & shipping", "Barcode & price", "File & spine", "Number & alphabet", "Sticker sheets"),
      },
      {
        n: "Envelopes & Packaging",
        k: [
          { n: "Envelopes", f: [pick("size", "Size", ["Small", "A4", "A3", "Other"], { filterable: true, showOnCard: true }), t("material", "Material"), yn("window", "Window"), packOf], k: leaves("Document", "Courier", "Bubble", "Money", "Invitation", "Kraft") },
          { n: "Paper & gift bags" },
          { n: "Wrapping paper & ribbons" },
        ],
      },
      {
        n: "Printing & Binding",
        k: [
          withF("Printer paper", [sizeA, num("gsm", "Paper weight", { unit: "GSM", filterable: true }), num("sheets", "Sheets", { showOnCard: true })]),
          { n: "Photo & sticker paper" },
          { n: "Ink & toner cartridges", f: [t("compatible_with", "Compatible with", { showOnCard: true })] },
          { n: "Binding", k: leaves("Spiral", "Comb", "Thermal", "Covers") },
          { n: "Laminating" },
        ],
      },
      {
        n: "Calculators",
        f: [num("digits", "Digits", { filterable: true }), pick("power", "Power", ["Solar", "Battery", "Solar + battery"], { filterable: true }), t("warranty", "Warranty")],
        k: leaves("Basic", "Scientific", "Financial", "Printing"),
      },
      {
        n: "Calendars & Planners",
        f: [t("year", "Year", { filterable: true })],
        k: leaves("Wall calendars", "Desk calendars", "Pocket calendars", "Diaries", "Planners"),
      },
    ],
  },
  {
    slug: "stationery_gifts_learning",
    name: "Gifts, Learning & More",
    roots: [
      {
        n: "Greeting & Gifts",
        k: [
          { n: "Greeting cards", f: [pick("occasion", "Occasion", ["Birthday", "Wedding", "Thank you", "Anniversary", "Festival", "Other"], { filterable: true })] },
          { n: "Invitation cards" },
          { n: "Gift tags & bags" },
        ],
      },
      {
        n: "Educational Products",
        f: [t("language", "Language", { filterable: true }), pick("age_group", "Age group", ["3-5 yrs", "6-8 yrs", "9-12 yrs", "13+ yrs", "All ages"], { filterable: true })],
        k: [
          withF("Charts & maps", [t("topic", "Topic", { filterable: true, showOnCard: true }), sizeA]),
          { n: "Globes & science models" },
          { n: "Workbooks & practice books" },
          { n: "Educational toys" },
        ],
      },
      {
        n: "Small Electronics",
        f: [t("warranty", "Warranty", { showOnCard: true })],
        k: [
          withF("USB drives & memory cards", [num("capacity", "Capacity", { unit: "GB", filterable: true, showOnCard: true })]),
          { n: "Cables & adapters" },
          { n: "Earphones & headphones" },
          withF("Batteries & chargers", [pick("battery_size", "Battery size", ["AA", "AAA", "9V", "Coin cell", "Other"], { filterable: true }), packOf]),
          withF("Power banks", [num("capacity", "Capacity", { unit: "mAh", filterable: true, showOnCard: true })]),
          { n: "Timers & presentation remotes" },
        ],
      },
      {
        n: "Miscellaneous",
        k: leaves("Magnets", "Keychains", "Lanyards & badges", "ID card holders", "Magnifiers", "Sewing kits", "Locks"),
      },
    ],
  },
];
