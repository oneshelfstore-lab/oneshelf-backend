// Reads a photo of a grocery list (handwritten or typed) into plain text lines via Gemini.
// The key stays server-side. Returns one string per list item, e.g. "Milk 2L" — matching those
// lines to the catalog happens on the device (same matcher voice search uses).

import prisma from "./prisma.js";

const MODEL =process.env.GEMINI_MODEL || "gemini-2.5-flash";

const PROMPT =
  "This is a photo of a grocery shopping list (handwritten or typed, English/Hindi/Hinglish). " +
  "Return every item as one line, keeping quantity and unit with the item exactly as written " +
  "(e.g. \"Milk 2L\", \"Atta 5 kg\", \"Maggi 4 pack\"). Transliterate Devanagari to Latin letters. " +
  "Ignore headings, prices, dates and anything that is not a grocery item. Do not invent items.";

export class OcrNotConfiguredError extends Error {}

export async function readGroceryList(imageBase64: string, mimeType: string): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new OcrNotConfiguredError("GEMINI_API_KEY not set");

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: { type: "ARRAY", items: { type: "STRING" } },
          temperature: 0,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!resp.ok) throw new Error(`Gemini ${resp.status}`);
  const json: any = await resp.json();
  const text: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  const lines = JSON.parse(text);
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
