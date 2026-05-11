import * as https from "node:https";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ExtractedMemory {
  content: string;
  tags: string[];
  importance: number;
}

// ── Extraction prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a memory extraction system for an AI assistant. Given a conversation or session summary, extract the most important facts worth remembering for future sessions.

Rules:
- Extract 3–10 specific, concrete facts — never vague summaries
- Each memory: 1–2 sentences, stands alone without conversation context
- Prioritise: user preferences, technical decisions, project details, personal context
- Skip: small talk, one-off tasks already done, anything obviously temporary
- tags: 2–4 lowercase labels from: preference, project, tooling, deploy, infra, coding, editor, personal, workflow
- importance: 0.9–1.0 critical preferences/key decisions | 0.6–0.8 useful context | 0.5 minor facts

Return ONLY a valid JSON array, no prose:
[{"content":"...","tags":["tag1","tag2"],"importance":0.8}]`;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract individual memories from a session summary or raw conversation text.
 * Uses Anthropic (ANTHROPIC_API_KEY) or OpenAI (OPENAI_API_KEY) if available.
 * Falls back to storing the raw text as a single memory when no key is set.
 */
export async function extractMemories(text: string): Promise<ExtractedMemory[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  const openaiKey    = process.env["OPENAI_API_KEY"];

  try {
    if (anthropicKey) return await viaAnthropic(anthropicKey, trimmed);
    if (openaiKey)    return await viaOpenAI(openaiKey, trimmed);
  } catch {
    // API or parse failure — fall through to raw storage
  }

  // No API key or extraction failed — store as a single raw memory
  return [{
    content: trimmed.slice(0, 500),
    tags: ["session"],
    importance: 0.5,
  }];
}

// ── Anthropic ──────────────────────────────────────────────────────────────

async function viaAnthropic(apiKey: string, text: string): Promise<ExtractedMemory[]> {
  const body = JSON.stringify({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
  });

  const raw = await post("api.anthropic.com", "/v1/messages", {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  }, body);

  const resp = JSON.parse(raw) as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0]?.text ?? "[]") as ExtractedMemory[];
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

async function viaOpenAI(apiKey: string, text: string): Promise<ExtractedMemory[]> {
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    max_tokens: 1024,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: text },
    ],
  });

  const raw = await post("api.openai.com", "/v1/chat/completions", {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  }, body);

  const resp = JSON.parse(raw) as { choices: Array<{ message: { content: string } }> };
  return JSON.parse(resp.choices[0]?.message.content ?? "[]") as ExtractedMemory[];
}

// ── HTTPS helper ───────────────────────────────────────────────────────────

function post(
  hostname: string,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve(data));
      },
    );
    req.setTimeout(20_000, () => { req.destroy(); reject(new Error("API timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
