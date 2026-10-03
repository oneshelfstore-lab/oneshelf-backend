// Toys & Games: 15 categories → children → grandchildren, as supplied. Age range, gender, character/franchise, pieces,
// battery type, skill level and colour are product FIELDS (not extra category levels), per the brief. Loaded by
// scripts/seedTree.ts (see data/catalogTrees.ts).
//
// Overlaps with trees already live (kept as supplied; decide later which side keeps them): STEM > Science Kits vs Books &
// Education > Educational Kits; Arts, Crafts & Creative Play (craft/clay/origami kits, play dough) vs Stationery & Office >
// Art & Craft; Playing Cards. Electronic toys stay here only when fundamentally a toy, not a consumer electronic device.
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const ageRange = pick("age_range", "Age range", ["0-1 yrs", "1-3 yrs", "3-5 yrs", "5-8 yrs", "8-12 yrs", "12+ yrs", "All ages"], { filterable: true, showOnCard: true });
const forWhom = pick("for_whom", "For", ["Boys", "Girls", "Unisex"], { filterable: true });
const character = t("character", "Character / franchise", { filterable: true });
const pieces = num("pieces", "Pieces", { filterable: true, showOnCard: true });
const battery = pick("battery_type", "Battery", ["None", "AA", "AAA", "Button cell", "Rechargeable"], { filterable: true });
const skill = pick("skill_level", "Skill level", ["Beginner", "Intermediate", "Advanced"], { filterable: true });
const colour = t("colour", "Colour", { filterable: true });
const material = pick("material", "Material", ["Plastic", "Wood", "Fabric", "Metal", "Rubber", "Paper / card"], { filterable: true });
const players = pick("players", "Players", ["1", "2", "2-4", "4+"], { filterable: true, showOnCard: true });

const common = [ageRange, forWhom, character];

export const TOYS: Root[] = [
  {
    n: "Baby & Toddler Toys", f: [ageRange, material, battery],
    k: [
      k("Early Development Toys", "Rattles", "Teethers", "Stacking Toys", "Shape Sorters", "Activity Toys"),
      k("Push & Pull Toys", "Push Toys", "Pull Toys", "Pull-Along Toys"),
      k("Baby Play Sets", "Bath Toys", "Sensory Toys", "Musical Baby Toys"),
    ],
  },
  {
    n: "Dolls & Dollhouses", f: [...common, material],
    k: [
      k("Dolls", "Fashion Dolls", "Baby Dolls", "Character Dolls", "Collectible Dolls"),
      k("Doll Accessories", "Doll Clothes", "Doll Shoes", "Doll Furniture", "Doll Accessories Set"),
      k("Dollhouses", "Dollhouse", "Dollhouse Furniture", "Dollhouse Play Set"),
    ],
  },
  {
    n: "Vehicles & Remote Control", f: [...common, battery, colour],
    k: [
      k("Toy Vehicles", "Toy Cars", "Toy Trucks", "Toy Buses", "Toy Trains", "Toy Construction Vehicles"),
      k("Remote Control Toys", "RC Cars", "RC Trucks", "RC Boats", "RC Helicopters"),
      k("Toy Tracks & Play Sets", "Car Track", "Train Set", "Vehicle Play Set"),
    ],
  },
  {
    n: "Action Figures & Collectibles", f: [...common, pieces],
    k: [
      k("Action Figures", "Superhero Figures", "Character Figures", "Military Figures", "Fantasy Figures"),
      k("Collectibles", "Collectible Figures", "Mini Figures", "Character Collectibles"),
      k("Play Sets", "Character Play Set", "Battle Play Set", "Adventure Play Set"),
    ],
  },
  {
    n: "Building & Construction", f: [ageRange, pieces, skill, material],
    k: [
      k("Building Blocks", "Building Blocks", "Magnetic Blocks", "Interlocking Blocks", "Wooden Blocks"),
      k("Construction Sets", "Construction Kit", "Engineering Kit", "Building Set"),
      k("Model Building", "Model Kits", "Vehicle Models", "Architecture Models"),
    ],
  },
  {
    n: "Educational Toys", f: [ageRange, forWhom, battery],
    k: [
      k("Learning Toys", "Alphabet Toys", "Number Toys", "Counting Toys", "Shape & Colour Toys"),
      k("STEM Toys", "Science Kits", "Robotics Kits", "Coding Toys", "Engineering Kits"),
      k("Educational Puzzles", "Learning Puzzles", "Number Puzzles", "Alphabet Puzzles"),
    ],
  },
  {
    n: "Puzzles", f: [ageRange, pieces, skill],
    k: [
      k("Jigsaw Puzzles", "Children's Jigsaw", "Adult Jigsaw", "3D Jigsaw"),
      k("Logic Puzzles", "Brain Teaser", "Sudoku", "Logic Puzzle"),
      k("Mechanical Puzzles", "Cube Puzzle", "Maze Puzzle", "3D Puzzle"),
    ],
  },
  {
    n: "Board Games", f: [ageRange, players, skill],
    k: [
      k("Classic Board Games", "Chess", "Ludo", "Carrom", "Checkers", "Snakes & Ladders"),
      k("Strategy Games", "Strategy Board Game", "Family Strategy Game", "Tactical Game"),
      k("Family Games", "Family Board Game", "Party Board Game", "Kids Board Game"),
    ],
  },
  {
    n: "Card Games", f: [ageRange, players, pieces],
    k: [
      k("Playing Cards", "Standard Playing Cards", "Premium Playing Cards", "Educational Cards"),
      k("Card Games", "Family Card Game", "Strategy Card Game", "Party Card Game"),
      { ...k("Collectible Cards", "Trading Cards", "Character Cards", "Collectible Card Packs"), f: [character] },
    ],
  },
  {
    n: "Outdoor & Active Play", f: [ageRange, forWhom, colour],
    k: [
      { ...k("Ride-On Toys", "Toy Car", "Ride-On Bike", "Push Car", "Electric Ride-On"), f: [battery, num("max_weight", "Max rider weight", { unit: "kg" })] },
      k("Outdoor Toys", "Sand Toys", "Water Toys", "Bubble Toys", "Outdoor Play Set"),
      k("Flying Toys", "Kite", "Toy Plane", "Boomerang", "Flying Disc"),
    ],
  },
  {
    n: "Pretend Play", f: [...common, pieces],
    k: [
      k("Role Play", "Doctor Play Set", "Kitchen Play Set", "Tool Play Set", "Makeup Pretend Set"),
      { ...k("Costume Play", "Costume Set", "Superhero Costume", "Character Costume"), f: [pick("size", "Size", ["2-3 yrs", "4-5 yrs", "6-7 yrs", "8-9 yrs", "10+ yrs"], { filterable: true, showOnCard: true })] },
      k("Pretend Play Sets", "Grocery Store Set", "Restaurant Play Set", "Housekeeping Play Set"),
    ],
  },
  {
    n: "Arts, Crafts & Creative Play", f: [ageRange, pieces],
    k: [
      k("Art Toys", "Colouring Set", "Drawing Set", "Painting Set"),
      k("Craft Kits", "DIY Craft Kit", "Jewellery Making Kit", "Clay Kit", "Origami Kit"),
      k("Creative Play", "Modelling Clay", "Slime", "Play Dough", "Activity Kit"),
    ],
  },
  {
    n: "Musical Toys", f: [ageRange, battery],
    k: [
      k("Toy Instruments", "Toy Keyboard", "Toy Piano", "Toy Guitar", "Toy Drum", "Toy Flute"),
      k("Musical Learning Toys", "Musical Activity Toy", "Musical Learning Set"),
      k("Electronic Musical Toys", "Electronic Keyboard", "Electronic Piano", "Singing Toy"),
    ],
  },
  {
    n: "Sports & Game Toys", f: [ageRange, forWhom, players],
    k: [
      k("Indoor Games", "Table Tennis Set", "Mini Basketball", "Mini Football", "Indoor Bowling"),
      k("Skill Games", "Ring Toss", "Target Game", "Yo-Yo", "Spinning Top"),
      k("Game Sets", "Sports Toy Set", "Activity Game Set", "Multi-Game Set"),
    ],
  },
  {
    n: "Novelty & Party Toys", f: [ageRange, num("pack_count", "Pieces in pack", { showOnCard: true })],
    k: [
      k("Novelty Toys", "Fidget Toy", "Stress Toy", "Squeeze Toy", "Magic Toy"),
      k("Party Toys", "Party Game", "Party Favour Toy", "Party Activity Set"),
      k("Seasonal Toys", "Festival Toys", "Holiday Toys", "Seasonal Play Set"),
    ],
  },
];
