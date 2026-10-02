// Reads a photo of a grocery list (handwritten or typed) into plain text lines via Gemini.
// The key stays server-side. Returns one string per list item, e.g. "Milk 2L" — matching those
// lines to the catalog happens on the device (same matcher voice search uses).

import prisma from "./prisma.js";
import { geminiJson } from "./gemini.js";

const PROMPT =
  "This is a photo of a grocery shopping list (handwritten or typed, English/Hindi/Hinglish). " +
  "Return every item as one line, keeping quantity and unit with the item exactly as written " +
  "(e.g. \"Milk 2L\", \"Atta 5 kg\", \"Maggi 4 pack\"). Transliterate Devanagari to Latin letters. " +
  "Ignore headings, prices, dates and anything that is not a grocery item. Do not invent items.";

// Same class under the old name, so `instanceof OcrNotConfiguredError` in routes keeps working.
export { GeminiNotConfiguredError as OcrNotConfiguredError } from "./gemini.js";

export async function readGroceryList(imageBase64: string, mimeType: string): Promise<string[]> {
  const lines = await geminiJson(
    [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: imageBase64 } }],
    { type: "ARRAY", items: { type: "STRING" } },
    "list-ocr",
  );
  if (!Array.isArray(lines)) return [];
  return lines.map((l) => String(l).trim()).filter(Boolean).slice(0, 80);
}

const DAILY_CAP = 15;
// Counts the attempt (a failed Gemini call still costs us), so check-then-call is race-free across instances.
export async function takeOcrQuota(userId: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const row = await prisma.listOcrUsage.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day, count: 1 },
    update: { count: { increment: 1 } },
  });
  return row.count <= DAILY_CAP;
}
