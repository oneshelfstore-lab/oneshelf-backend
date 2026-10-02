// The one place that talks to Gemini. Callers pass parts + a response schema and get parsed JSON back.
// The key stays server-side. Shared by the grocery-list OCR (lib/listOcr.ts) and the product-editor
// assistant (services/productIntelligence.ts).

// Tried in order; a model that is overloaded (503/429) or retired for this key (404) is skipped.
// ponytail: pinned names retire (gemini-2.5-flash already 404s) — re-check with ListModels now and then.
const MODELS = [
  ...(process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : []),
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
];

export class GeminiNotConfiguredError extends Error {}

export type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

/** Calls the first model that answers; throws GeminiNotConfiguredError without a key, Error on failure. */
export async function geminiJson(
  parts: GeminiPart[],
  responseSchema: object,
  tag: string,
  opts: { temperature?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiNotConfiguredError("GEMINI_API_KEY not set");

  const call = (model: string) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema, temperature: opts.temperature ?? 0 },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    },
  );
  let resp!: Response;
  for (const model of MODELS) {
    try {
      resp = await call(model);
    } catch (e) {
      console.warn(`${tag} ${model} network/timeout:`, e);
      continue;
    }
    if (resp.ok) break;
    console.warn(`${tag} ${model} -> ${resp.status}`);
    if (![503, 429, 404].includes(resp.status)) break; // a real error (400/403): other models won't help
  }
  if (!resp?.ok) throw new Error(`Gemini ${resp?.status ?? "unreachable"}`);
  const json: any = await resp.json();
  // Real token counts per call, to turn the price table into actual ₹ (thoughts are billed as output).
  const u = json?.usageMetadata;
  if (u) {
    console.info(`${tag} usage model=${json.modelVersion ?? "?"} in=${u.promptTokenCount} out=${u.candidatesTokenCount} thoughts=${u.thoughtsTokenCount ?? 0}`);
  }
  return JSON.parse(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "null");
}
