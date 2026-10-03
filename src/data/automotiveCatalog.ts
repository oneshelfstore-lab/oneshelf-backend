// Automotive: 10 categories → children → grandchildren, as supplied. Vehicle compatibility is a FIELD system (vehicle
// type, make, model, variant, year, position, OEM/aftermarket, part number, compatibility) — never category levels,
// so the tree cannot explode into thousands of vehicle-specific categories. Loaded by scripts/seedTree.ts.
//
// Kept as supplied: Fuse, Spark Plug and Battery Charger each appear twice (Electrical Parts / Engine Parts etc.);
// car-care cleaning tools vs Cleaning & Household > Cleaning Tools (car-specific, so they stay here).
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const warranty = t("warranty", "Warranty", { showOnCard: true });
const colour = t("colour", "Colour", { filterable: true });
const packQty = num("pack_qty", "Pack quantity", { showOnCard: true });

/** The compatibility field set shared by anything that fits specific vehicles. */
const vehicle = [
  pick("vehicle_type", "Vehicle type", ["Car", "Motorcycle", "Scooter", "SUV / MUV", "Truck / Commercial", "Universal"], { filterable: true, showOnCard: true }),
  t("vehicle_make", "Vehicle brand", { filterable: true, showOnCard: true }),
  t("vehicle_model", "Vehicle model", { filterable: true, showOnCard: true }),
  t("vehicle_variant", "Variant"),
  t("vehicle_year", "Year / range", { filterable: true }),
  t("compatibility", "Compatible with"),
];
const part = [
  pick("position", "Position", ["Front", "Rear", "Left", "Right", "Front + Rear", "Universal"], { filterable: true }),
  pick("part_origin", "Part type", ["OEM", "Aftermarket"], { filterable: true, showOnCard: true }),
  t("part_number", "Part number"),
  packQty,
];

export const AUTOMOTIVE: Root[] = [
  {
    n: "Car Accessories", f: [...vehicle.slice(0, 3), colour, warranty],
    k: [
      k("Interior Accessories", "Car Seat Cover", "Car Floor Mat", "Car Dashboard Mat", "Car Sun Shade", "Car Neck Pillow"),
      k("Exterior Accessories", "Car Body Cover", "Number Plate Frame", "Mud Flap", "Door Guard"),
      k("Car Organizers", "Car Organizer", "Boot Organizer", "Seat Back Organizer"),
      k("Car Convenience", "Car Phone Holder", "Car Tissue Holder", "Car Hanger", "Car Trash Bin"),
    ],
  },
  {
    n: "Motorcycle & Scooter Accessories", f: [vehicle[1]!, vehicle[2]!, colour, warranty],
    k: [
      k("Riding Accessories", "Bike Cover", "Tank Cover", "Saddle Bag", "Mobile Holder"),
      k("Protection", "Crash Guard", "Hand Guard", "Engine Guard"),
      k("Utility Accessories", "Bungee Cord", "Luggage Net", "Bike Stand"),
    ],
  },
  {
    n: "Car Electronics", f: [warranty, t("model", "Model", { showOnCard: true }), vehicle[5]!],
    k: [
      k("Dash Cameras", "Dash Cam", "Dual Channel Dash Cam", "Dash Cam Accessories"),
      { ...k("Car Audio", "Car Speaker", "Car Stereo", "Car Subwoofer", "Car Amplifier"), f: [num("power", "Power", { unit: "W", filterable: true, showOnCard: true })] },
      k("Car Connectivity", "Bluetooth Car Adapter", "FM Transmitter", "Car USB Charger"),
      k("Vehicle Electronics", "Parking Sensor", "Reverse Camera", "GPS Tracker", "TPMS"),
    ],
  },
  {
    n: "Car Care", f: [num("quantity", "Quantity", { unit: "ml", filterable: true, showOnCard: true }), pick("vehicle_type", "Suitable for", ["Car", "Motorcycle", "Scooter", "All vehicles"], { filterable: true })],
    k: [
      k("Exterior Cleaning", "Car Shampoo", "Car Wash Liquid", "Car Wax", "Car Polish"),
      k("Interior Cleaning", "Dashboard Cleaner", "Interior Cleaner", "Upholstery Cleaner", "Glass Cleaner"),
      k("Cleaning Tools", "Car Cleaning Cloth", "Car Cleaning Brush", "Car Wash Mitt", "Car Cleaning Kit"),
      k("Protection", "Paint Protection", "Tyre Polish", "Windshield Treatment"),
    ],
  },
  {
    n: "Automotive Oils & Fluids", f: [num("quantity", "Quantity", { unit: "L", filterable: true, showOnCard: true }), pick("vehicle_type", "Vehicle type", ["Car", "Motorcycle", "Scooter", "Truck / Commercial", "Universal"], { filterable: true, showOnCard: true })],
    k: [
      { ...k("Engine Oils", "Car Engine Oil", "Motorcycle Engine Oil", "Scooter Engine Oil"), f: [t("viscosity", "Viscosity grade", { filterable: true, showOnCard: true }), pick("oil_type", "Oil type", ["Fully synthetic", "Semi synthetic", "Mineral"], { filterable: true, showOnCard: true }), pick("fuel", "Fuel", ["Petrol", "Diesel", "CNG", "Any"], { filterable: true })] },
      k("Transmission Fluids", "Gear Oil", "Automatic Transmission Fluid", "Transmission Oil"),
      k("Coolants", "Engine Coolant", "Radiator Coolant"),
      k("Other Fluids", "Brake Fluid", "Power Steering Fluid", "Windshield Washer Fluid"),
    ],
  },
  {
    n: "Tyres & Wheels", f: [vehicle[0]!, vehicle[1]!, vehicle[2]!, warranty],
    k: [
      { ...k("Tyres", "Car Tyre", "Motorcycle Tyre", "Scooter Tyre", "Tubeless Tyre"), f: [t("tyre_size", "Tyre size (e.g. 185/65 R15)", { filterable: true, showOnCard: true }), yn("tubeless", "Tubeless", { filterable: true }), t("tyre_brand", "Tyre brand", { filterable: true })] },
      k("Tubes", "Motorcycle Tube", "Scooter Tube", "Bicycle-Type Tube"),
      { ...k("Wheels", "Alloy Wheel", "Steel Wheel", "Wheel Rim"), f: [num("rim_size", "Rim size", { unit: "inch", filterable: true, showOnCard: true }), t("pcd", "PCD / bolt pattern")] },
      k("Tyre Accessories", "Tyre Inflator", "Tyre Repair Kit", "Tyre Pressure Gauge", "Valve Cap"),
    ],
  },
  {
    n: "Batteries & Electrical", f: [...vehicle.slice(0, 3), warranty],
    k: [
      { ...k("Vehicle Batteries", "Car Battery", "Motorcycle Battery", "Scooter Battery"), f: [num("voltage", "Voltage", { unit: "V", filterable: true }), num("capacity_ah", "Capacity", { unit: "Ah", filterable: true, showOnCard: true }), pick("polarity", "Polarity", ["Left (+)", "Right (+)"], { filterable: true })] },
      k("Battery Accessories", "Battery Charger", "Battery Terminal", "Battery Cable"),
      { ...k("Electrical Parts", "Fuse", "Relay", "Spark Plug", "Ignition Coil"), f: [...part] },
    ],
  },
  {
    n: "Spare Parts", f: [...vehicle, ...part],
    k: [
      k("Engine Parts", "Air Filter", "Oil Filter", "Fuel Filter", "Spark Plug"),
      k("Brake Parts", "Brake Pad", "Brake Shoe", "Brake Disc", "Brake Cable"),
      k("Suspension & Steering", "Shock Absorber", "Strut", "Steering Component", "Suspension Bush"),
      k("Body Parts", "Side Mirror", "Door Handle", "Wiper Blade", "Car Bulb"),
    ],
  },
  {
    n: "Tools & Emergency", f: [warranty],
    k: [
      k("Vehicle Tools", "Car Jack", "Wheel Spanner", "Torque Wrench", "Tool Kit"),
      k("Emergency Equipment", "Jump Starter", "Tow Rope", "Warning Triangle", "Emergency Hammer"),
      k("Roadside Assistance", "Puncture Repair Kit", "Air Compressor", "Emergency Kit"),
    ],
  },
  {
    n: "Automotive Lighting", f: [...vehicle.slice(0, 3), pick("bulb_type", "Bulb / base type", ["H1", "H3", "H4", "H7", "H11", "9005", "9006", "T10", "Other"], { filterable: true, showOnCard: true }), num("wattage", "Wattage", { unit: "W", filterable: true }), pick("light_colour", "Light colour", ["White", "Warm white", "Yellow", "Amber", "Red", "Blue"], { filterable: true }), packQty],
    k: [
      k("Vehicle Bulbs", "Headlight Bulb", "Tail Light Bulb", "Indicator Bulb", "Fog Light Bulb"),
      k("Auxiliary Lighting", "LED Headlight", "Fog Light", "LED Bar", "Auxiliary Light"),
      k("Lighting Accessories", "Bulb Adapter", "Light Relay", "Wiring Harness"),
    ],
  },
];
