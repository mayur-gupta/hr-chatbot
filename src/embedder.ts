import OpenAI from "openai";
import type { Settings } from "./config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Embedder {
  private client: OpenAI;
  dimension = 0;

  constructor(private settings: Settings) {
    this.client = new OpenAI({ baseURL: settings.lmstudioBaseUrl, apiKey: settings.lmstudioApiKey, maxRetries: 0 });
  }

  /** Confirm LM Studio is up, the model is loaded, and learn the vector dimension. */
  async healthCheck(): Promise<number> {
    const { lmstudioBaseUrl: url, embedModel: model } = this.settings;
    let ids: string[];
    try {
      const models = await this.client.models.list();
      ids = models.data.map((m) => m.id);
    } catch (err) {
      throw new Error(
        `Cannot reach LM Studio at ${url} (${(err as Error).message}).\n` +
          `Start the server in LM Studio (Developer tab -> Start Server) and load "${model}".`,
      );
    }
    if (!ids.includes(model)) {
      throw new Error(
        `Embedding model "${model}" is not available in LM Studio.\n` +
          `Available: ${ids.join(", ") || "(none)"}\n` +
          `Load it in LM Studio, or set EMBED_MODEL in .env to one of the above.`,
      );
    }
    const [probe] = await this.embedRaw(["dimension probe"]);
    this.dimension = probe.length;
    return this.dimension;
  }

  private async embedRaw(inputs: string[], attempts = 3): Promise<number[][]> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.client.embeddings.create({ model: this.settings.embedModel, input: inputs });
        const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding as number[]);
        if (vectors.length !== inputs.length) {
          throw new Error(`expected ${inputs.length} embeddings, got ${vectors.length}`);
        }
        return vectors;
      } catch (err) {
        if (attempt >= attempts) throw err;
        await sleep(500 * 2 ** (attempt - 1));
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
    return this.embedChecked(texts.map((t) => this.settings.queryPrefix + t));
  }
}
