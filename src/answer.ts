/** Generation side of the RAG: build a grounded prompt and stream an answer from an OpenAI-compatible chat model. */
import OpenAI from "openai";
import { isLocal, type Settings } from "./config.js";
import type { Hit } from "./retriever.js";

export type Turn = { role: "user" | "assistant"; content: string };

/** Citation label for a chunk, e.g. "KAL-GB-HR-017 §6" (section 0 is the per-document summary). */
export function citeLabel(h: Hit): string {
  return h.sectionNo === 0 ? `${h.docId} summary` : `${h.docId} §${h.sectionNo}`;
}

const SYSTEM_PROMPT = `You are the Kalvora HR policy assistant. You answer employee and HR questions using ONLY the policy excerpts provided in the user's message.

Rules:
- Base every statement on the excerpts. Do not use outside knowledge of employment law, and do not guess numbers, dates or names.
- Kalvora has a separate version of each policy for each country, and they differ. Only use excerpts from the country the question is about. If the question names no country and the answer differs by country, say so and give the answer per country, or ask which country they mean.
- Cite the source after each fact in square brackets, using the label shown on the excerpt, e.g. [KAL-GB-HR-017 §6].
- If the excerpts do not contain the answer, say: "I couldn't find this in the Kalvora HR policies." Then mention which policy might cover it if one looks related.
- Be concise: a direct answer first, then supporting details as short bullets if useful.`;

function contextBlock(hits: Hit[]): string {
  return hits
    .map((h) => `[${citeLabel(h)}] ${h.title} (${h.country}) | ${h.sectionTitle}\n${h.text}`)
    .join("\n\n---\n\n");
}

export class Answerer {
  private client: OpenAI;
  model = "";

  constructor(private settings: Settings) {
    this.client = new OpenAI({ baseURL: settings.chat.baseUrl, apiKey: settings.chat.apiKey || "none", maxRetries: 1 });
  }

  /**
   * Pick the chat model. A hosted provider needs CHAT_MODEL and is trusted as-is (no extra
   * request on every cold start). LM Studio: CHAT_MODEL is checked against the loaded models,
   * or the first non-embedding model is used.
   */
  async init(override?: string): Promise<string> {
    const wanted = (override ?? this.settings.chatModel).trim();
    if (!isLocal(this.settings.chat)) {
      if (!wanted) throw new Error(`CHAT_MODEL is required for ${this.settings.chat.baseUrl}. List the options with: npm run models`);
      return (this.model = wanted);
    }
    const ids = (await this.client.models.list()).data.map((m) => m.id);
    const chatIds = ids.filter((id) => !/embed/i.test(id));
    if (wanted) {
      if (!ids.includes(wanted)) {
        throw new Error(
          `Chat model "${wanted}" is not available in LM Studio.
` +
            `Available chat models: ${chatIds.join(", ") || "(none)"}
` +
            `Load it in LM Studio, or change CHAT_MODEL in .env.`,
        );
      }
      this.model = wanted;
    } else {
      if (!chatIds.length) {
        throw new Error(
          `No chat model is available in LM Studio (only: ${ids.join(", ") || "nothing"}).
` +
            `Download and load a chat model (e.g. Qwen or Llama) in LM Studio, or set CHAT_MODEL in .env.`,
        );
      }
      this.model = chatIds[0];
    }
    return this.model;
  }

  /** Stream an answer, calling onToken for visible text. Returns the full visible answer. */
  async answer(
    question: string,
    hits: Hit[],
    history: Turn[],
    onToken: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const user = hits.length
      ? `Policy excerpts:\n\n${contextBlock(hits)}\n\n===\n\nQuestion: ${question}`
      : `No policy excerpts were found for this question.\n\nQuestion: ${question}`;

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        temperature: 0.1,
        stream: true,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: user }],
      },
      { signal },
    );

    // Reasoning models (Qwen3, DeepSeek-R1...) may emit <think>...</think> inline; hide it.
    let raw = "";
    let printed = 0;
    for await (const part of stream) {
      raw += part.choices[0]?.delta?.content ?? "";
      const visible = stripThinking(raw);
      // Hold back a trailing partial "<think" so it is never printed half-way.
      const safeEnd = partialTagStart(visible);
      if (safeEnd > printed) {
        onToken(visible.slice(printed, safeEnd));
        printed = safeEnd;
      }
    }
    const visible = stripThinking(raw);
    if (visible.length > printed) onToken(visible.slice(printed));
    return visible.trim();
  }
}

function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").replace(/^\s+/, "");
}

function partialTagStart(s: string): number {
  const tag = "<think>";
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return s.length - n;
  }
  return s.length;
}
