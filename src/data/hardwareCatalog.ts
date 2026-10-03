// Hardware & Electrical: 11 categories → children → grandchildren, as supplied. Size and specification are product
// FIELDS (head type, drive type, material, length, diameter, conductor, cross-section, cores, voltage rating, pack
// quantity…), never category levels — this keeps tens of thousands of hardware SKUs manageable. Loaded by
// scripts/seedTree.ts.
//
// Overlaps with live trees, kept as supplied (each under its own parent): Adhesives / Super Glue / Tapes vs Stationery >
// Adhesives & Tapes; Utility Knife / Hacksaw vs Stationery > Cutting Tools; Measuring Tape vs Stationery > Geometry;
// Light Bulb vs Cleaning > Household Consumables; Safety Gloves vs Cleaning > Cleaning Accessories; Marker; Hook;
// Rope / Utility Cord vs Home & Kitchen > Home Utility. Masking Tape and Cable Tie each appear twice in this tree.
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const material = (...o: string[]) => pick("material", "Material", o, { filterable: true, showOnCard: true });
const warranty = t("warranty", "Warranty", { showOnCard: true });
const packQty = num("pack_qty", "Pack quantity", { showOnCard: true });
const lengthMm = num("length", "Length", { unit: "mm", filterable: true, showOnCard: true });
const diameterMm = num("diameter", "Diameter", { unit: "mm", filterable: true, showOnCard: true });
const size = t("size", "Size", { filterable: true, showOnCard: true });
const colour = t("colour", "Colour", { filterable: true });
const finish = t("finish", "Finish", { filterable: true });
const wattage = num("wattage", "Wattage", { unit: "W", filterable: true, showOnCard: true });
const amps = num("current_rating", "Current rating", { unit: "A", filterable: true, showOnCard: true });

const wire = [
  pick("conductor", "Conductor", ["Copper", "Aluminium", "Tinned copper"], { filterable: true, showOnCard: true }),
  pick("cross_section", "Cross-section", ["0.5 sq mm", "0.75 sq mm", "1 sq mm", "1.5 sq mm", "2.5 sq mm", "4 sq mm", "6 sq mm", "10 sq mm", "16 sq mm"], { filterable: true, showOnCard: true }),
  num("cores", "Number of cores", { filterable: true }),
  pick("insulation", "Insulation", ["PVC", "FR PVC", "XLPE", "Rubber", "Silicone"], { filterable: true }),
  num("wire_length", "Length", { unit: "m", showOnCard: true }),
  num("voltage_rating", "Voltage rating", { unit: "V" }),
];
const screw = [
  pick("head_type", "Head type", ["Flat", "Pan", "Round", "Hex", "Button", "Countersunk"], { filterable: true }),
  pick("drive_type", "Drive type", ["Phillips", "Slotted", "Torx", "Hex socket", "Pozidriv"], { filterable: true }),
  material("Steel", "Stainless steel", "Brass", "Zinc plated", "Galvanised"),
  lengthMm, diameterMm,
  pick("thread_type", "Thread type", ["Coarse", "Fine", "Self-tapping", "Machine"], { filterable: true }),
  packQty,
];

export const HARDWARE: Root[] = [
  {
    n: "Electrical", f: [colour, warranty],
    k: [
      { ...k("Switches & Sockets", "Modular Switch", "Electrical Socket", "Plug", "Fan Regulator", "Switch Board"), f: [amps, num("modules", "Modules"), material("Polycarbonate", "Plastic", "Metal")] },
      { ...k("Wires & Cables", "Electrical Wire", "Flexible Cable", "Coaxial Cable", "Electrical Cable"), f: wire },
      { ...k("MCB & Protection", "MCB", "RCCB", "Distribution Board", "Fuse"), f: [amps, pick("poles", "Poles", ["SP", "DP", "TP", "4P"], { filterable: true }), num("breaking_capacity", "Breaking capacity", { unit: "kA" })] },
      k("Electrical Fittings", "Junction Box", "Cable Gland", "Conduit", "Cable Tie"),
      k("Electrical Accessories", "Terminal Block", "Connector", "Insulation Tape", "Electrical Tester"),
    ],
  },
  {
    n: "Lighting", f: [warranty, colour],
    k: [
      { ...k("LED Lighting", "LED Bulb", "LED Tube Light", "LED Panel Light", "LED Downlight"), f: [wattage, pick("colour_temp", "Colour temperature", ["Warm white", "Cool white", "Daylight"], { filterable: true, showOnCard: true }), pick("base_type", "Base type", ["B22", "E27", "E14", "Other"], { filterable: true }), num("lumens", "Brightness", { unit: "lm" })] },
      k("Decorative Lighting", "Strip Light", "String Light", "Decorative Bulb", "Outdoor Decorative Light"),
      { ...k("Outdoor Lighting", "Flood Light", "Street Light", "Garden Light", "Security Light"), f: [wattage, pick("ip_rating", "IP rating", ["IP20", "IP44", "IP54", "IP65", "IP66", "IP67"], { filterable: true })] },
      k("Lighting Components", "Lamp Holder", "Ceiling Rose", "Light Fixture", "LED Driver"),
    ],
  },
  {
    n: "Hand Tools", f: [material("Steel", "Chrome vanadium", "Carbon steel", "Stainless steel"), size],
    k: [
      k("Cutting Tools", "Utility Knife", "Wire Cutter", "Bolt Cutter", "Hacksaw"),
      k("Pliers", "Combination Pliers", "Long Nose Pliers", "Cutting Pliers", "Locking Pliers"),
      { ...k("Screwdrivers", "Flat Screwdriver", "Phillips Screwdriver", "Precision Screwdriver", "Screwdriver Set"), f: [num("pieces", "Pieces in set")] },
      { ...k("Wrenches & Spanners", "Adjustable Wrench", "Combination Spanner", "Ring Spanner", "Socket Set"), f: [num("pieces", "Pieces in set")] },
      { ...k("Hammers", "Claw Hammer", "Ball Peen Hammer", "Rubber Mallet", "Sledge Hammer"), f: [num("head_weight", "Head weight", { unit: "g", filterable: true })] },
    ],
  },
  {
    n: "Power Tools", f: [warranty, wattage, num("voltage", "Voltage", { unit: "V" }), pick("power_source", "Power source", ["Corded", "Cordless"], { filterable: true, showOnCard: true })],
    k: [
      k("Drills", "Electric Drill", "Cordless Drill", "Hammer Drill", "Impact Drill"),
      k("Cutting & Grinding", "Angle Grinder", "Cutting Machine", "Circular Saw", "Jigsaw"),
      k("Sanding & Polishing", "Sander", "Polisher", "Rotary Tool"),
      { ...k("Power Tool Accessories", "Drill Bit", "Saw Blade", "Grinding Disc", "Sanding Disc"), f: [size, material("Steel", "HSS", "Carbide", "Diamond"), packQty] },
    ],
  },
  {
    n: "Fasteners", f: screw,
    k: [
      k("Screws", "Wood Screw", "Self Tapping Screw", "Machine Screw", "Drywall Screw"),
      k("Nails", "Common Nail", "Masonry Nail", "Finishing Nail"),
      k("Nuts & Bolts", "Hex Bolt", "Nut", "Washer", "Anchor Bolt"),
      k("Wall Fixings", "Wall Plug", "Rawl Plug", "Drywall Anchor", "Hook"),
    ],
  },
  {
    n: "Plumbing", f: [material("PVC", "CPVC", "UPVC", "GI", "Brass", "Stainless steel", "Copper"), size],
    k: [
      { ...k("Pipes & Fittings", "PVC Pipe", "CPVC Pipe", "Pipe Elbow", "Pipe Tee", "Pipe Connector"), f: [pick("pressure_rating", "Pressure rating", ["Class 1", "Class 2", "Class 3", "SDR 11", "SDR 13.5"], { filterable: true })] },
      { ...k("Taps & Faucets", "Water Tap", "Bib Cock", "Mixer Tap", "Faucet"), f: [finish] },
      k("Valves", "Ball Valve", "Stop Valve", "Check Valve", "Angle Valve"),
      k("Plumbing Accessories", "Pipe Clamp", "PTFE Tape", "Pipe Sealant", "Pipe Repair Kit"),
    ],
  },
  {
    n: "Adhesives & Sealants", f: [num("quantity", "Quantity", { unit: "g", showOnCard: true })],
    k: [
      k("Adhesives", "Super Glue", "Epoxy Adhesive", "Wood Adhesive", "Construction Adhesive"),
      k("Sealants", "Silicone Sealant", "Acrylic Sealant", "Thread Sealant"),
      { ...k("Tapes", "Duct Tape", "Double Sided Tape", "Masking Tape", "Foam Tape"), f: [num("width", "Width", { unit: "mm", filterable: true, showOnCard: true }), num("tape_length", "Length", { unit: "m", showOnCard: true })] },
    ],
  },
  {
    n: "Building & Construction Hardware", f: [material("Stainless steel", "Brass", "Iron", "Aluminium", "Zinc alloy", "Plastic"), finish, size],
    k: [
      k("Door & Window Hardware", "Door Handle", "Door Hinge", "Door Stopper", "Window Handle", "Window Hinge"),
      { ...k("Locks & Security", "Padlock", "Door Lock", "Cabinet Lock", "Lock Cylinder"), f: [pick("lock_type", "Lock type", ["Key", "Combination", "Digital", "Smart"], { filterable: true })] },
      k("Brackets & Supports", "L Bracket", "Shelf Bracket", "Corner Bracket", "Mounting Bracket"),
      k("Chains & Hooks", "Metal Chain", "S Hook", "Eye Hook", "Utility Hook"),
    ],
  },
  {
    n: "Paint & Surface Supplies", f: [size],
    k: [
      k("Painting Tools", "Paint Brush", "Paint Roller", "Paint Tray", "Paint Scraper"),
      { ...k("Surface Preparation", "Sandpaper", "Putty Knife", "Wall Scraper"), f: [t("grit", "Grit", { filterable: true })] },
      k("Painting Accessories", "Masking Tape", "Paint Bucket", "Drop Cloth"),
    ],
  },
  {
    n: "Measuring & Safety",
    k: [
      { ...k("Measuring Tools", "Measuring Tape", "Spirit Level", "Vernier Caliper", "Measuring Wheel"), f: [t("range", "Range", { filterable: true, showOnCard: true })] },
      k("Marking Tools", "Marker", "Carpenter Pencil", "Chalk Line"),
      { ...k("Safety Equipment", "Safety Gloves", "Safety Goggles", "Safety Helmet", "Dust Mask"), f: [pick("size", "Size", ["S", "M", "L", "XL", "Free size"], { filterable: true, showOnCard: true }), yn("isi_marked", "ISI / certified", { filterable: true })] },
    ],
  },
  {
    n: "Workshop & Utility",
    k: [
      k("Storage", "Tool Box", "Tool Bag", "Parts Organizer", "Storage Case"),
      { ...k("Workshop Consumables", "Lubricant", "Cutting Oil", "Cleaning Solvent", "Rust Remover"), f: [num("quantity", "Quantity", { unit: "ml", filterable: true, showOnCard: true })] },
      { ...k("Utility Hardware", "Rope", "Wire", "Cable Tie", "Utility Cord"), f: [material("Nylon", "Cotton", "Jute", "Steel", "Polypropylene"), num("rope_length", "Length", { unit: "m", showOnCard: true }), diameterMm] },
    ],
  },
];
