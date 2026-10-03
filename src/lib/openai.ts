// The one place that talks to OpenAI. Callers pass a prompt + a strict JSON schema and get parsed JSON back.
// The key stays server-side (Railway variables). Used by the product-editor assistant
// (services/productIntelligence.ts); the grocery-list OCR still uses lib/gemini.ts.

export class OpenAINotConfiguredError extends Error {}

/** Model is an env var so it can be upgraded without a deploy. */
const model = () => process.env.OPENAI_MODEL || "gpt-5-nano";

/**
 * Chat Completions with Structured Outputs: the reply is guaranteed to match `schema`
 * (every property required, additionalProperties false — see productIntelligence's RESPONSE_SCHEMA).
 *
 * ⚠️ gpt-5 models are reasoning models: no custom temperature, and the reasoning tokens count against
 * `max_completion_tokens`, so the cap is generous. `reasoning_effort: "minimal"` keeps it fast and cheap.
 */
export async function openaiJson(
  prompt: string,
  schema: object,
  tag: string,
  opts: { timeoutMs?: number; maxTokens?: number } = {},
): Promise<unknown> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new OpenAINotConfiguredError("OPENAI_API_KEY not set");

  const m = model();
  const call = (withEffort: boolean) =>
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: m,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } },
        max_completion_tokens: opts.maxTokens ?? 4000,
        ...(withEffort && m.startsWith("gpt-5") ? { reasoning_effort: "minimal" } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 40_000),
    });

  let resp = await call(true);
  // A model that doesn't know reasoning_effort answers 400; retry once without it.
  if (resp.status === 400) resp = await call(false);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${tag} openai ${m} -> ${resp.status} ${body.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  const msg = data?.choices?.[0]?.message;
  if (msg?.refusal) throw new Error(`${tag} openai refused: ${String(msg.refusal).slice(0, 200)}`);
  const text = msg?.content;
  if (typeof text !== "string" || !text) throw new Error(`${tag} openai returned no content (finish: ${data?.choices?.[0]?.finish_reason})`);
  return JSON.parse(text);
}
