import OpenAI from "openai";
import { isLocal, type Settings } from "./config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Status codes worth retrying: rate limits (free tiers hit these often) and transient server errors. */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export class Embedder {
  private client: OpenAI;
  dimension = 0;
  /** Prepended to queries. The retriever replaces it with the prefix the stored vectors were built for. */
  queryPrefix: string;

  constructor(private settings: Settings) {
    this.client = new OpenAI({ baseURL: settings.embed.baseUrl, apiKey: settings.embed.apiKey || "none", maxRetries: 0 });
    this.queryPrefix = settings.queryPrefix;
  }

  /** Confirm the endpoint answers with the configured model, and learn the vector dimension. */
  async healthCheck(): Promise<number> {
    const { embed, embedModel: model } = this.settings;
    try {
      const [probe] = await this.embedRaw(["dimension probe"], 2);
      this.dimension = probe.length;
      return this.dimension;
    } catch (err) {
      const reason = (err as Error).message;
      if (!isLocal(embed)) throw new Error(`Embedding request to ${embed.baseUrl} with model "${model}" failed: ${reason}`);
      // LM Studio: explain whether the server is down or the model isn't loaded.
      const ids = await this.client.models
        .list()
        .then((m) => m.data.map((d) => d.id))
        .catch(() => null);
      if (!ids) {
        throw new Error(
          `Cannot reach LM Studio at ${embed.baseUrl} (${reason}).\n` +
            `Start the server in LM Studio (Developer tab -> Start Server) and load "${model}".`,
        );
      }
      throw new Error(
        `Embedding model "${model}" failed in LM Studio (${reason}).\n` +
          `Available: ${ids.join(", ") || "(none)"}\n` +
          `Load it in LM Studio, or set EMBED_MODEL in .env to one of the above.`,
      );
    }
  }

  private async embedRaw(inputs: string[], attempts = 6): Promise<number[][]> {
    for (let attempt = 1; ; attempt++) {
      try {
        const { embedModel: model, embedDimensions: dimensions } = this.settings;
        const res = await this.client.embeddings.create({ model, input: inputs, ...(dimensions ? { dimensions } : {}) });
        const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding as number[]);
        if (vectors.length !== inputs.length) {
          throw new Error(`expected ${inputs.length} embeddings, got ${vectors.length}`);
        }
        return vectors;
      } catch (err) {
        const status = (err as { status?: number }).status;
        const retryable = status === undefined || RETRYABLE.has(status);
        if (!retryable || attempt >= attempts) throw err;
        // Rate limits need a real pause (free tiers count requests per minute).
        const base = status === 429 ? 5000 : 500;
        await sleep(Math.min(60_000, base * 2 ** (attempt - 1)));
      }
    }
  }

  private async embedChecked(inputs: string[]): Promise<number[][]> {
    const vectors = await this.embedRaw(inputs);
    for (const v of vectors) {
      if (this.dimension && v.length !== this.dimension) {
        throw new Error(`embedding dimension changed: expected ${this.dimension}, got ${v.length}`);
      }
    }
    return vectors;
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embedChecked(texts.map((t) => this.settings.docPrefix + t));
  }

  embedQueries(texts: string[]): Promise<number[][]> {
    return this.embedChecked(texts.map((t) => this.queryPrefix + t));
  }
}
