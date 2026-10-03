// Sports & Fitness: 13 categories → children → grandchildren, as supplied. Sport, brand, size, age group, skill level,
// material, weight, dimensions, resistance level, colour and pack quantity are product FIELDS, never category levels.
// Loaded by scripts/seedTree.ts. Bicycles live here (cycling products are treated as sports, not Automotive).
//
// Kept as supplied (each under its own parent): Yoga Mat appears under both Fitness Accessories and Yoga Equipment;
// Shin Guard (Football / Combat); Training Cone (Football / Basketball / Sports Accessories); Ball Pump, Ball Bag, Racket
// Grip / Cover, Sports Bottle, Hydration Pack; Sports Watch vs Electronics > Smart Devices.
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const age = pick("age_group", "Age group", ["Kids", "Junior", "Adult", "All ages"], { filterable: true, showOnCard: true });
const skill = pick("skill_level", "Skill level", ["Beginner", "Intermediate", "Professional"], { filterable: true });
const size = t("size", "Size", { filterable: true, showOnCard: true });
const colour = t("colour", "Colour", { filterable: true });
const material = t("material", "Material", { filterable: true });
const weightKg = num("weight", "Weight", { unit: "kg", filterable: true, showOnCard: true });
const warranty = t("warranty", "Warranty", { showOnCard: true });
const packQty = num("pack_qty", "Pack quantity", { showOnCard: true });
const ballSize = pick("ball_size", "Ball size", ["1", "2", "3", "4", "5", "6", "7"], { filterable: true, showOnCard: true });
const gear = [size, age, colour];

export const SPORTS: Root[] = [
  {
    n: "Fitness & Exercise", f: [colour, material],
    k: [
      { ...k("Strength Training", "Dumbbells", "Kettlebells", "Barbell", "Weight Plates", "Weight Set"), f: [weightKg, pick("coating", "Coating", ["Rubber", "Neoprene", "Vinyl", "Cast iron", "Chrome"], { filterable: true })] },
      { ...k("Resistance Training", "Resistance Band", "Resistance Tube", "Hand Grip", "Ankle Weights"), f: [pick("resistance", "Resistance level", ["Light", "Medium", "Heavy", "Extra heavy"], { filterable: true, showOnCard: true })] },
      { ...k("Cardio Equipment", "Treadmill", "Exercise Bike", "Elliptical Trainer", "Stepper"), f: [warranty, num("max_user_weight", "Max user weight", { unit: "kg", filterable: true }), pick("drive", "Drive", ["Motorised", "Manual", "Magnetic"], { filterable: true })] },
      k("Fitness Accessories", "Yoga Mat", "Exercise Mat", "Skipping Rope", "Foam Roller", "Ab Roller"),
    ],
  },
  {
    n: "Yoga & Wellness Fitness", f: [colour, material],
    k: [
      { ...k("Yoga Equipment", "Yoga Mat", "Yoga Block", "Yoga Strap", "Yoga Wheel"), f: [num("thickness", "Thickness", { unit: "mm", filterable: true, showOnCard: true })] },
      k("Pilates", "Pilates Ring", "Pilates Ball", "Pilates Band"),
      k("Meditation Accessories", "Meditation Cushion", "Meditation Mat", "Meditation Bench"),
    ],
  },
  {
    n: "Running & Walking", f: [colour, size],
    k: [
      k("Running Accessories", "Running Belt", "Hydration Belt", "Running Armband", "Running Pouch"),
      k("Walking Accessories", "Walking Stick", "Pedometer", "Reflective Gear"),
      k("Training Accessories", "Sports Watch", "Stopwatch", "Sports Bottle"),
    ],
  },
  {
    n: "Cricket", f: [age, skill],
    k: [
      { ...k("Cricket Bats", "English Willow Bat", "Kashmir Willow Bat", "Tennis Cricket Bat"), f: [pick("bat_size", "Bat size", ["Size 3", "Size 4", "Size 5", "Size 6", "Harrow", "Short Handle", "Long Handle"], { filterable: true, showOnCard: true }), num("bat_weight", "Weight", { unit: "g", filterable: true })] },
      k("Cricket Equipment", "Cricket Ball", "Cricket Stumps", "Cricket Gloves", "Cricket Helmet"),
      { ...k("Cricket Protection", "Batting Pads", "Thigh Guard", "Abdominal Guard", "Arm Guard"), f: [size, pick("hand", "Hand", ["Right", "Left", "Universal"], { filterable: true })] },
      k("Cricket Accessories", "Bat Grip", "Bat Tape", "Cricket Kit Bag", "Bat Cover"),
    ],
  },
  {
    n: "Football", f: [age, skill],
    k: [
      { ...k("Footballs", "Match Football", "Training Football", "Futsal Ball"), f: [ballSize, material] },
      k("Football Equipment", "Football Goal", "Training Cone", "Training Ladder", "Practice Net"),
      k("Football Accessories", "Shin Guard", "Ball Pump", "Ball Bag"),
    ],
  },
  {
    n: "Badminton", f: [age, skill],
    k: [
      { ...k("Rackets", "Badminton Racket", "Junior Badminton Racket"), f: [pick("racket_weight", "Weight class", ["2U", "3U", "4U", "5U"], { filterable: true, showOnCard: true }), pick("balance", "Balance", ["Head heavy", "Even", "Head light"], { filterable: true }), material] },
      { ...k("Shuttlecocks", "Feather Shuttlecock", "Nylon Shuttlecock"), f: [packQty, pick("speed", "Speed", ["Slow", "Medium", "Fast"], { filterable: true })] },
      k("Badminton Accessories", "Badminton Net", "Racket Grip", "Racket Cover", "Shuttlecock Tube"),
    ],
  },
  {
    n: "Tennis & Racquet Sports", f: [age, skill],
    k: [
      k("Tennis", "Tennis Racket", "Tennis Ball", "Tennis Net"),
      k("Table Tennis", "Table Tennis Bat", "Table Tennis Ball", "Table Tennis Net"),
      k("Racquet Accessories", "Racket Grip", "Racket String", "Racket Cover"),
    ],
  },
  {
    n: "Basketball", f: [age, ballSize],
    k: [
      k("Basketballs", "Basketball", "Training Basketball"),
      k("Basketball Equipment", "Basketball Hoop", "Basketball Board", "Basketball Net"),
      k("Basketball Accessories", "Ball Pump", "Ball Bag", "Training Cone"),
    ],
  },
  {
    n: "Cycling", f: [colour, warranty],
    k: [
      { ...k("Bicycles", "Mountain Bike", "Road Bike", "Hybrid Bike", "Kids Bicycle"), f: [num("frame_size", "Frame size", { unit: "inch", filterable: true, showOnCard: true }), num("wheel_size", "Wheel size", { unit: "inch", filterable: true, showOnCard: true }), num("gears", "Number of gears", { filterable: true }), pick("brakes", "Brake type", ["Rim", "Disc", "Coaster"], { filterable: true }), age] },
      k("Cycling Accessories", "Bicycle Helmet", "Bicycle Lock", "Bicycle Pump", "Water Bottle Holder"),
      { ...k("Bicycle Parts", "Bicycle Tyre", "Bicycle Tube", "Bicycle Pedal", "Bicycle Saddle"), f: [num("wheel_size", "Wheel size", { unit: "inch", filterable: true })] },
    ],
  },
  {
    n: "Swimming", f: [age, colour],
    k: [
      k("Swimming Equipment", "Swimming Goggles", "Kickboard", "Pull Buoy", "Swimming Fins"),
      k("Training Equipment", "Swim Paddle", "Swim Cap", "Nose Clip"),
      k("Swimming Accessories", "Swimming Bag", "Waterproof Case", "Pool Accessories"),
    ],
  },
  {
    n: "Outdoor & Adventure", f: [colour, material],
    k: [
      { ...k("Camping", "Tent", "Sleeping Bag", "Camping Chair", "Camping Table"), f: [num("capacity_persons", "Capacity", { unit: "persons", filterable: true, showOnCard: true }), weightKg] },
      k("Hiking", "Trekking Pole", "Hiking Backpack", "Hydration Pack", "Compass"),
      k("Outdoor Accessories", "Headlamp", "Camping Lantern", "Portable Stove", "Outdoor Mat"),
    ],
  },
  {
    n: "Combat & Martial Arts", f: [...gear, material],
    k: [
      k("Boxing", "Boxing Gloves", "Punching Bag", "Hand Wraps", "Boxing Headgear"),
      k("Martial Arts", "Martial Arts Gloves", "Training Pads", "Kick Shield", "Training Equipment"),
      k("Protective Equipment", "Mouth Guard", "Shin Guard", "Protective Headgear"),
    ],
  },
  {
    n: "Sports Accessories", f: [colour],
    k: [
      { ...k("Hydration", "Sports Bottle", "Hydration Flask", "Hydration Pack"), f: [num("capacity", "Capacity", { unit: "ml", filterable: true, showOnCard: true }), material] },
      k("Training Accessories", "Training Cone", "Agility Ladder", "Resistance Parachute", "Training Hurdle"),
      { ...k("Sports Equipment Bags", "Sports Bag", "Kit Bag", "Equipment Bag"), f: [num("capacity_l", "Capacity", { unit: "L", filterable: true, showOnCard: true })] },
    ],
  },
];
