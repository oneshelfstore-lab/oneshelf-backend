// Electronics & Accessories: 14 categories → children → grandchildren, as supplied. Brand, model, RAM, storage, screen
// size, colour, connectivity, battery capacity, wattage, voltage, connector type, OS and compatibility are product FIELDS
// (or variants), never category levels — no "Samsung > Galaxy > S-series" nodes. Loaded by scripts/seedTree.ts.
//
// Boundary: consumer electronics, gadgets, computers, mobile devices and their accessories. Electrical installation
// (wiring, switches, sockets) is Hardware & Electrical; electronic toys are Toys & Games; educational calculators are
// Stationery & Office > Calculators. The supplied tree repeats a few items in two places (Tripod, HDMI Cable, Laptop
// Stand, Screen Protector, Memory Card, Rechargeable Battery); kept as supplied, each under its own parent.
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const model = t("model", "Model", { showOnCard: true });
const colour = t("colour", "Colour", { filterable: true });
const warranty = t("warranty", "Warranty", { showOnCard: true });
const base = [model, colour, warranty];
const compatible = t("compatible_with", "Compatible with", { showOnCard: true });
const ram = pick("ram", "RAM", ["2 GB", "3 GB", "4 GB", "6 GB", "8 GB", "12 GB", "16 GB", "32 GB", "64 GB"], { filterable: true, showOnCard: true });
const storage = pick("storage", "Storage", ["32 GB", "64 GB", "128 GB", "256 GB", "512 GB", "1 TB", "2 TB"], { filterable: true, showOnCard: true });
const screen = num("screen_size", "Screen size", { unit: "inch", filterable: true, showOnCard: true });
const os = pick("os", "Operating system", ["Android", "iOS", "Windows", "macOS", "Linux", "Other"], { filterable: true });
const connectivity = pick("connectivity", "Connectivity", ["Wired", "Bluetooth", "Wi-Fi", "Wired + Bluetooth"], { filterable: true, showOnCard: true });
const connector = pick("connector", "Connector", ["USB-A", "USB-C", "Lightning", "Micro-USB", "HDMI", "3.5 mm", "Other"], { filterable: true, showOnCard: true });
const wattage = num("wattage", "Wattage", { unit: "W", filterable: true, showOnCard: true });
const batteryLife = num("battery_life", "Battery life", { unit: "hrs", showOnCard: true });

export const ELECTRONICS: Root[] = [
  {
    n: "Mobile & Tablet", f: [...base, ram, storage, screen, os],
    k: [
      k("Mobile Phones", "Smartphones", "Feature Phones", "Rugged Phones"),
      k("Tablets", "Android Tablets", "iPad", "Drawing Tablets"),
      { ...k("Mobile Accessories", "Phone Case", "Screen Protector", "Pop Socket", "Mobile Stand"), f: [compatible] },
    ],
  },
  {
    n: "Chargers & Power", f: [model, colour, warranty, wattage, connector],
    k: [
      k("Chargers", "Wall Charger", "Fast Charger", "Wireless Charger", "Car Charger"),
      { ...k("Power Banks", "Power Bank", "Magnetic Power Bank"), f: [num("capacity", "Capacity", { unit: "mAh", filterable: true, showOnCard: true })] },
      { ...k("Cables", "USB Cable", "USB-C Cable", "Lightning Cable", "HDMI Cable"), f: [num("length", "Length", { unit: "m", filterable: true, showOnCard: true })] },
      k("Power Accessories", "Extension Board", "Surge Protector", "Travel Adapter", "Plug Adapter"),
    ],
  },
  {
    n: "Audio", f: [...base, connectivity, batteryLife],
    k: [
      k("Headphones", "Wired Headphones", "Wireless Headphones", "Over-Ear Headphones"),
      k("Earphones", "Wired Earphones", "True Wireless Earbuds"),
      { ...k("Speakers", "Bluetooth Speaker", "Portable Speaker", "Computer Speaker"), f: [wattage] },
      k("Audio Accessories", "AUX Cable", "Audio Adapter", "Headphone Stand"),
    ],
  },
  {
    n: "Computers & Peripherals", f: [...base],
    k: [
      { ...k("Computers", "Laptop", "Desktop Computer", "Mini PC", "All-in-One PC"), f: [t("processor", "Processor", { filterable: true, showOnCard: true }), ram, storage, screen, os] },
      { ...k("Computer Accessories", "Laptop Stand", "Laptop Sleeve", "Laptop Cooling Pad", "Webcam Cover"), f: [compatible] },
      { ...k("Input Devices", "Keyboard", "Mouse", "Graphics Tablet", "Game Controller"), f: [connectivity] },
      { ...k("USB & Connectivity", "USB Hub", "Card Reader", "USB Adapter", "Docking Station"), f: [connector] },
    ],
  },
  {
    n: "Storage & Memory", f: [model, warranty, pick("capacity", "Capacity", ["8 GB", "16 GB", "32 GB", "64 GB", "128 GB", "256 GB", "512 GB", "1 TB", "2 TB", "4 TB"], { filterable: true, showOnCard: true }), t("speed", "Speed / class")],
    k: [
      k("Memory Cards", "MicroSD Card", "SD Card", "CompactFlash Card"),
      k("USB Storage", "Pen Drive", "External SSD"),
      k("Hard Drives", "External Hard Drive", "Internal Hard Drive", "Portable SSD"),
    ],
  },
  {
    n: "Cameras & Photography", f: [...base],
    k: [
      { ...k("Cameras", "DSLR Camera", "Mirrorless Camera", "Compact Camera", "Action Camera"), f: [num("megapixels", "Megapixels", { unit: "MP", filterable: true, showOnCard: true })] },
      { ...k("Camera Accessories", "Camera Bag", "Camera Strap", "Memory Card", "Camera Battery"), f: [compatible] },
      { ...k("Lenses", "Prime Lens", "Zoom Lens", "Wide Angle Lens"), f: [t("lens_mount", "Lens mount", { filterable: true }), t("focal_length", "Focal length", { showOnCard: true })] },
      k("Photography Equipment", "Tripod", "Monopod", "Camera Light", "Camera Flash"),
    ],
  },
  {
    n: "Video & Content Creation", f: [...base],
    k: [
      { ...k("Microphones", "Lavalier Microphone", "Wireless Microphone", "USB Microphone", "Shotgun Microphone"), f: [connector] },
      { ...k("Lighting", "Ring Light", "LED Video Light", "Softbox Light", "RGB Light"), f: [wattage] },
      k("Camera Support", "Tripod", "Gimbal", "Selfie Stick", "Camera Mount"),
      k("Streaming Accessories", "Capture Card", "Stream Deck", "Webcam", "Teleprompter"),
    ],
  },
  {
    n: "Smart Devices", f: [...base, connectivity],
    k: [
      { ...k("Smartwatches", "Smartwatch", "Kids Smartwatch"), f: [compatible, batteryLife, screen] },
      k("Smart Home", "Smart Bulb", "Smart Plug", "Smart Switch", "Smart Sensor"),
      k("Smart Speakers", "Smart Speaker", "Smart Display"),
      k("Smart Trackers", "Bluetooth Tracker", "GPS Tracker"),
    ],
  },
  {
    n: "TV & Home Entertainment", f: [...base],
    k: [
      { ...k("Televisions", "LED TV", "Smart TV", "QLED TV"), f: [screen, pick("resolution", "Resolution", ["HD", "Full HD", "4K", "8K"], { filterable: true, showOnCard: true }), yn("smart", "Smart TV", { filterable: true })] },
      k("Streaming Devices", "Streaming Stick", "Streaming Box"),
      { ...k("Home Audio", "Soundbar", "Home Theatre System", "AV Receiver"), f: [wattage] },
      k("TV Accessories", "TV Wall Mount", "HDMI Cable", "Remote Control"),
    ],
  },
  {
    n: "Gaming", f: [...base, pick("platform", "Platform", ["PlayStation", "Xbox", "Nintendo", "PC", "Mobile", "Universal"], { filterable: true, showOnCard: true })],
    k: [
      k("Gaming Consoles", "Gaming Console", "Handheld Console", "Retro Console"),
      { ...k("Gaming Accessories", "Gaming Controller", "Gaming Headset", "Gaming Mouse", "Gaming Keyboard"), f: [connectivity] },
      k("Gaming Equipment", "Gaming Chair", "Gaming Desk", "VR Headset"),
    ],
  },
  {
    n: "Wearable Electronics", f: [...base, compatible, batteryLife],
    k: [
      k("Smart Bands", "Fitness Band", "Activity Tracker"),
      k("Smart Glasses", "Smart Glasses", "AR Glasses"),
      k("Wearable Accessories", "Smartwatch Strap", "Smartwatch Charger", "Wearable Protector"),
    ],
  },
  {
    n: "Networking", f: [model, warranty, pick("band", "Band", ["Single band", "Dual band", "Tri band"], { filterable: true }), t("speed", "Speed", { showOnCard: true }), t("wifi_standard", "Wi-Fi standard", { filterable: true })],
    k: [
      k("Wi-Fi Devices", "Wi-Fi Router", "Wi-Fi Extender", "Mesh Wi-Fi System"),
      k("Network Equipment", "Network Switch", "Network Adapter", "Access Point"),
      k("Connectivity", "Bluetooth Adapter", "Wi-Fi Adapter", "Ethernet Adapter"),
    ],
  },
  {
    n: "Electronic Accessories", f: [colour, compatible],
    k: [
      { ...k("Adapters", "USB Adapter", "Audio Adapter", "Display Adapter"), f: [connector] },
      k("Mounts & Stands", "Phone Stand", "Tablet Stand", "Monitor Stand", "Laptop Stand"),
      k("Protection", "Screen Protector", "Cable Protector", "Electronics Case"),
    ],
  },
  {
    n: "Batteries & Power Cells", f: [pick("battery_size", "Battery size", ["AA", "AAA", "C", "D", "9V", "Coin cell", "Other"], { filterable: true, showOnCard: true }), num("voltage", "Voltage", { unit: "V", filterable: true }), num("capacity", "Capacity", { unit: "mAh", showOnCard: true }), num("pack_count", "Pieces in pack", { showOnCard: true }), yn("rechargeable", "Rechargeable", { filterable: true })],
    k: [
      k("Batteries", "AA Battery", "AAA Battery", "Coin Cell Battery", "Rechargeable Battery"),
      k("Rechargeable Power", "Rechargeable Battery", "Battery Charger"),
      k("Specialty Batteries", "Camera Battery", "Laptop Battery", "UPS Battery"),
    ],
  },
];

/** The stray mouse pad filed under the old insect_killer root belongs with computer accessories. */
export const ELECTRONICS_MOVES: { name?: string; subcategory?: string; from: string; path: string[] }[] = [
  { name: "Mouse pad", from: "insect_killer", path: ["Computers & Peripherals", "Computer Accessories"] },
];
