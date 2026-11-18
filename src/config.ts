import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });

const schema = z.object({
  CORPUS_DIR: z.string().min(1, "CORPUS_DIR is required (see .env.example)"),
  LMSTUDIO_BASE_URL: z.string().url().default("http://localhost:1234/v1"),
  LMSTUDIO_API_KEY: z.string().default("lm-studio"),
  CHAT_MODEL: z.string().default(""),
  TOP_K: z.coerce.number().int().positive().default(6),
  EMBED_MODEL: z.string().min(1).default("text-embedding-nomic-embed-text-v1.5"),
  DOC_PREFIX: z.string().default("search_document: "),
  QUERY_PREFIX: z.string().default("search_query: "),
  CHROMA_URL: z.string().url().default("http://localhost:8000"),
  COLLECTION: z.string().min(1).default("kalvora_hr"),
  BATCH_SIZE: z.coerce.number().int().positive().default(64),
});

export interface Settings {
  corpusDir: string;
  lmstudioBaseUrl: string;
  lmstudioApiKey: string;
  /** Chat model id in LM Studio; empty = auto-pick the first non-embedding model. */
  chatModel: string;
  topK: number;
  embedModel: string;
  docPrefix: string;
  queryPrefix: string;
  chromaUrl: string;
  collection: string;
  batchSize: number;
  chunksPath: string;
}

export function loadSettings(): Settings {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const env = parsed.data;
  return {
    corpusDir: path.resolve(PROJECT_ROOT, env.CORPUS_DIR),
    lmstudioBaseUrl: env.LMSTUDIO_BASE_URL,
    lmstudioApiKey: env.LMSTUDIO_API_KEY,
    chatModel: env.CHAT_MODEL.trim(),
    topK: env.TOP_K,
    embedModel: env.EMBED_MODEL,
    docPrefix: env.DOC_PREFIX,
    queryPrefix: env.QUERY_PREFIX,
    chromaUrl: env.CHROMA_URL,
    collection: env.COLLECTION,
    batchSize: env.BATCH_SIZE,
    chunksPath: path.join(PROJECT_ROOT, "data", "chunks.jsonl"),
  };
}
