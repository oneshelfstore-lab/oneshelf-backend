// Pet Supplies: 10 categories → children → grandchildren, as supplied. Pet type, breed size, age/life stage, weight,
// flavour, ingredient, pack size and compatibility are product FIELDS, never category levels. Loaded by
// scripts/seedTree.ts. Pet food, pet medicines, pet grooming and pet toys stay here, not in the human equivalents.
//
// Kept as supplied: Litter Scoop and Pet/Dog/Cat Carrier-type items appear under more than one parent.
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t, yn } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const petType = pick("pet_type", "Pet type", ["Dog", "Cat", "Rabbit", "Hamster", "Guinea pig", "Bird", "Fish", "Other small pet"], { filterable: true, showOnCard: true });
const lifeStage = pick("life_stage", "Life stage", ["Puppy / Kitten", "Adult", "Senior", "All life stages"], { filterable: true, showOnCard: true });
const breedSize = pick("breed_size", "Breed size", ["Small", "Medium", "Large", "Giant", "All sizes"], { filterable: true });
const flavour = t("flavour", "Flavour", { filterable: true, showOnCard: true });
const itemSize = pick("size", "Size", ["XS", "S", "M", "L", "XL", "Free size"], { filterable: true, showOnCard: true });
const colour = t("colour", "Colour", { filterable: true });
const material = t("material", "Material", { filterable: true });
const petWeight = t("pet_weight", "Suitable pet weight", { filterable: true });

export const PETS: Root[] = [
  {
    n: "Pet Food", f: [petType, lifeStage, breedSize, flavour, t("main_ingredient", "Main ingredient", { filterable: true }), yn("grain_free", "Grain free", { filterable: true })],
    k: [
      k("Dog Food", "Dry Dog Food", "Wet Dog Food", "Puppy Food", "Dog Treats"),
      k("Cat Food", "Dry Cat Food", "Wet Cat Food", "Kitten Food", "Cat Treats"),
      k("Small Animal Food", "Rabbit Food", "Hamster Food", "Guinea Pig Food"),
      k("Pet Supplements", "Vitamins", "Joint Supplements", "Digestive Supplements", "Skin & Coat Supplements"),
    ],
  },
  {
    n: "Dog Supplies", f: [itemSize, colour, breedSize],
    k: [
      k("Collars & Leashes", "Dog Collar", "Dog Leash", "Harness", "Retractable Leash"),
      k("Dog Bedding", "Dog Bed", "Dog Mat", "Dog Blanket"),
      { ...k("Dog Feeding", "Dog Bowl", "Automatic Feeder", "Water Dispenser"), f: [num("capacity", "Capacity", { unit: "ml", filterable: true, showOnCard: true }), material] },
      k("Dog Accessories", "Dog Muzzle", "Dog Tag", "Dog Raincoat", "Dog Travel Bag"),
    ],
  },
  {
    n: "Cat Supplies", f: [colour],
    k: [
      { ...k("Cat Litter", "Clumping Litter", "Non-Clumping Litter", "Silica Litter", "Natural Litter"), f: [num("weight", "Weight", { unit: "kg", filterable: true, showOnCard: true }), t("scent", "Scent", { filterable: true })] },
      k("Litter Accessories", "Litter Box", "Litter Scoop", "Litter Mat"),
      { ...k("Cat Feeding", "Cat Bowl", "Cat Feeder", "Cat Water Fountain"), f: [num("capacity", "Capacity", { unit: "ml", showOnCard: true }), material] },
      k("Cat Accessories", "Cat Collar", "Cat Harness", "Cat Carrier"),
    ],
  },
  {
    n: "Pet Grooming", f: [petType],
    k: [
      k("Bath & Cleaning", "Pet Shampoo", "Pet Conditioner", "Pet Wipes", "Pet Cleaning Spray"),
      k("Grooming Tools", "Pet Brush", "Deshedding Tool", "Pet Comb", "Grooming Kit"),
      k("Nail Care", "Pet Nail Clipper", "Nail Grinder", "Nail File"),
      k("Dental Care", "Pet Toothbrush", "Pet Toothpaste", "Dental Chews"),
    ],
  },
  {
    n: "Pet Toys", f: [petType, breedSize, material, colour],
    k: [
      k("Dog Toys", "Chew Toy", "Rope Toy", "Fetch Toy", "Squeaky Toy"),
      k("Cat Toys", "Cat Ball", "Cat Wand", "Catnip Toy", "Interactive Cat Toy"),
      k("Interactive Toys", "Puzzle Toy", "Treat Dispenser Toy", "Electronic Pet Toy"),
    ],
  },
  {
    n: "Pet Health & Wellness", f: [petType],
    k: [
      k("Health Care", "Pet First Aid Kit", "Wound Care", "Recovery Accessories"),
      { ...k("Parasite Control", "Flea Treatment", "Tick Treatment", "Deworming Products"), f: [t("active_ingredient", "Active ingredient", { showOnCard: true }), petWeight] },
      k("Health Accessories", "Pet Thermometer", "Recovery Collar", "Pet Medical Accessories"),
    ],
  },
  {
    n: "Pet Cleaning & Waste", f: [petType],
    k: [
      { ...k("Dog Waste", "Poop Bags", "Poop Bag Dispenser", "Pooper Scooper"), f: [num("pack_count", "Pieces in pack", { showOnCard: true })] },
      k("Cat Waste", "Litter Bags", "Litter Scoop", "Litter Disposal System"),
      k("Pet Cleaning", "Pet Stain Remover", "Odor Eliminator", "Pet Cleaning Wipes"),
    ],
  },
  {
    n: "Pet Housing", f: [itemSize, material, colour],
    k: [
      k("Dog Housing", "Dog Kennel", "Dog House", "Dog Crate"),
      k("Cat Housing", "Cat House", "Cat Bed", "Cat Carrier"),
      k("Small Animal Housing", "Rabbit Hutch", "Hamster Cage", "Guinea Pig Cage"),
    ],
  },
  {
    n: "Pet Travel", f: [petType, itemSize, petWeight, colour],
    k: [
      k("Carriers", "Pet Carrier", "Soft Pet Carrier", "Hard Pet Carrier"),
      k("Travel Accessories", "Pet Travel Bowl", "Travel Water Bottle", "Pet Travel Bag"),
      k("Vehicle Accessories", "Pet Car Seat", "Car Safety Harness", "Pet Car Barrier"),
    ],
  },
  {
    n: "Aquarium & Small Pets", f: [petType],
    k: [
      { ...k("Aquarium", "Fish Food", "Aquarium Filter", "Aquarium Pump", "Aquarium Decoration"), f: [num("tank_size", "Suitable tank size", { unit: "L", filterable: true }), num("wattage", "Wattage", { unit: "W" })] },
      k("Bird Supplies", "Bird Food", "Bird Cage", "Bird Feeder", "Bird Perch"),
      k("Small Pet Supplies", "Rabbit Supplies", "Hamster Supplies", "Guinea Pig Supplies", "Small Pet Accessories"),
    ],
  },
];
