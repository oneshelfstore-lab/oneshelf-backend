// Books & Education: 6 categories → children → grandchildren, plus light per-category product fields.
// Loaded by scripts/seedTree.ts (see data/catalogTrees.ts).
//
// Boundary: Books & Education = things used for learning/teaching or educational content. General writing, filing,
// printing, office and school stationery (notebooks, pens, bags, pencil boxes, calculators, exam pads, drawing and craft
// supplies, desk organisers) live in Stationery & Office and are NOT repeated here — every product has one home.
// Left out of the supplied tree for that reason: the whole "School Supplies" root; Art & Craft Education >
// Drawing & Painting + Craft Supplies; Educational Electronics > Calculators; Educational Accessories >
// Exam Accessories; Study Accessories > Desk Organizer + Pen Stand.
import type { Root } from "./stationeryCatalog.js";
import { leaves, num, pick, t } from "./stationeryCatalog.js";

const k = (n: string, ...grand: string[]) => ({ n, ...(grand.length ? { k: leaves(...grand) } : {}) });
const language = pick("language", "Language", ["English", "Hindi", "Bilingual", "Other"], { filterable: true, showOnCard: true });
const pages = num("pages", "Pages", { showOnCard: true });

export const BOOKS: Root[] = [
  {
    n: "Books",
    f: [t("author", "Author", { showOnCard: true }), t("publisher", "Publisher"), language, pages, pick("binding", "Binding", ["Paperback", "Hardcover"], { filterable: true }), t("isbn", "ISBN")],
    k: [
      { ...k("Academic Books", "School Textbooks", "College Textbooks", "University Textbooks", "Professional Textbooks", "Reference Books"), f: [pick("board", "Board / level", ["CBSE", "ICSE", "State board", "College", "Other"], { filterable: true }), t("class_level", "Class / subject", { filterable: true, showOnCard: true })] },
      k("Competitive Exam Books", "NEET", "JEE", "UPSC", "SSC", "Banking Exams", "Railway Exams", "Defence Exams", "State Government Exams"),
      k("General & Non-Fiction", "Self-Help", "Business", "Finance", "History", "Science", "Technology", "Biography & Memoir"),
      k("Fiction", "Novels", "Short Stories", "Romance", "Mystery & Thriller", "Fantasy", "Science Fiction"),
      { ...k("Children's Books", "Picture Books", "Story Books", "Activity Books", "Early Learning Books", "Comics"), f: [pick("age_group", "Age group", ["0-3 yrs", "3-5 yrs", "6-8 yrs", "9-12 yrs", "13+ yrs"], { filterable: true, showOnCard: true })] },
      k("Religious & Spiritual Books", "Religious Texts", "Spiritual Books", "Philosophy"),
    ],
  },
  {
    n: "Study Material", f: [language, pages, t("class_level", "Class / exam", { filterable: true, showOnCard: true })],
    k: [
      k("Notes & Guides", "Study Notes", "Revision Guides", "Chapter Guides", "Quick Revision Books"),
      k("Question Banks", "Practice Questions", "Previous Year Questions", "MCQ Books", "Solved Papers"),
      k("Workbooks", "Practice Workbook", "Mathematics Workbook", "Language Workbook", "Activity Workbook"),
      k("Test Series", "Mock Tests", "Practice Tests", "Sample Papers"),
    ],
  },
  {
    n: "Educational & Learning", f: [pick("age_group", "Age group", ["3-5 yrs", "6-8 yrs", "9-12 yrs", "13+ yrs", "All ages"], { filterable: true, showOnCard: true }), t("language", "Language", { filterable: true })],
    k: [
      k("Early Learning", "Alphabet Learning", "Number Learning", "Flash Cards", "Learning Cards"),
      k("Educational Kits", "Science Kit", "Mathematics Kit", "Geography Kit", "Educational Activity Kit"),
      { ...k("Learning Aids", "Educational Charts", "Maps", "Globes", "Models"), f: [t("topic", "Topic", { filterable: true, showOnCard: true })] },
      k("Language Learning", "English Learning", "Hindi Learning", "Foreign Language Learning", "Grammar Books"),
    ],
  },
  { n: "Art & Craft Education", k: [k("Educational Art", "Drawing Guides", "Art Instruction Books", "Calligraphy Books")] },
  {
    n: "Educational Electronics", f: [t("warranty", "Warranty", { showOnCard: true })],
    k: [
      k("Learning Devices", "Electronic Dictionary", "Digital Writing Pad", "Educational Tablet"),
      k("Presentation Tools", "Laser Pointer", "Presentation Remote", "Document Camera"),
    ],
  },
  {
    n: "Educational Accessories",
    k: [
      k("Book Accessories", "Bookmark", "Book Stand", "Reading Light", "Book Holder"),
      k("Study Accessories", "Study Lamp", "Study Timer"),
    ],
  },
];
