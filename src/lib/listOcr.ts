// Reads a photo of a grocery list (handwritten or typed) into plain text lines via Gemini.
// The key stays server-side. Returns one string per list item, e.g. "Milk 2L" — matching those
// lines to the catalog happens on the device (same matcher voice search uses).

import prisma from "./prisma.js";

// Tried in order; a model that is overloaded (503/429) or retired for this key (404) is skipped.
// ponytail: pinned names retire (gemini-2.5-flash already 404s) — re-check with ListModels now and then.
const MODELS = [
  ...(process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : []),
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
];

const PROMPT =
  "This is a photo of a grocery shopping list (handwritten or typed, English/Hindi/Hinglish). " +
  "Return every item as one line, keeping quantity and unit with the item exactly as written " +
  "(e.g. \"Milk 2L\", \"Atta 5 kg\", \"Maggi 4 pack\"). Transliterate Devanagari to Latin letters. " +
  "Ignore headings, prices, dates and anything that is not a grocery item. Do not invent items.";

export class OcrNotConfiguredError extends Error {}

export async function readGroceryList(imageBase64: string, mimeType: string): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new OcrNotConfiguredError("GEMINI_API_KEY not set");

  const call = (model: string) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
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
      signal: AbortSignal.timeout(20_000),
    },
  );
  let resp!: Response;
  for (const model of MODELS) {
    try {
      resp = await call(model);
    } catch (e) {
      console.warn(`list-ocr ${model} network/timeout:`, e);
      continue;
    }
    if (resp.ok) break;
    console.warn(`list-ocr ${model} -> ${resp.status}`);
    if (![503, 429, 404].includes(resp.status)) break; // a real error (400/403): other models won't help
  }
  if (!resp?.ok) throw new Error(`Gemini ${resp?.status ?? "unreachable"}`);
  const json: any = await resp.json();
  // Real token counts per scan, to turn the price table into actual ₹ (thoughts are billed as output).
  const u = json?.usageMetadata;
  if (u) {
    console.info(`list-ocr usage model=${json.modelVersion ?? "?"} in=${u.promptTokenCount} out=${u.candidatesTokenCount} thoughts=${u.thoughtsTokenCount ?? 0}`);
  }
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
