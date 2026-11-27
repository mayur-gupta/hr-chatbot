import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });

const optionalInt = z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.coerce.number().int().positive().optional());

const schema = z.object({
  /** Only the ingestion pipeline needs the corpus; the API and the deployed app don't. */
  CORPUS_DIR: z.string().default(""),
  // LM Studio defaults. CHAT_* / EMBED_* override them, so any OpenAI-compatible provider works.
  LMSTUDIO_BASE_URL: z.string().url().default("http://localhost:1234/v1"),
  LMSTUDIO_API_KEY: z.string().default("lm-studio"),
  CHAT_BASE_URL: z.string().default(""),
  CHAT_API_KEY: z.string().default(""),
  CHAT_MODEL: z.string().default(""),
  EMBED_BASE_URL: z.string().default(""),
  EMBED_API_KEY: z.string().default(""),
  EMBED_MODEL: z.string().min(1).default("text-embedding-nomic-embed-text-v1.5"),
  /** Ask the provider for shorter vectors (e.g. 768); empty = the model's default size. */
  EMBED_DIMENSIONS: optionalInt,
  /** Pause between embedding batches during ingestion, to stay under free-tier rate limits. */
  EMBED_DELAY_MS: z.coerce.number().int().min(0).default(0),
  TOP_K: z.coerce.number().int().positive().default(6),
  DOC_PREFIX: z.string().default("search_document: "),
  QUERY_PREFIX: z.string().default("search_query: "),
  /**
   * "supabase" = Supabase pgvector; "chroma" = a Chroma server; "file" = the vector index in INDEX_DIR.
   * Default: supabase on Vercel, else chroma.
   */
  VECTOR_STORE: z.enum(["chroma", "file", "supabase"]).optional(),
  INDEX_DIR: z.string().default("data/index"),
  CHROMA_URL: z.string().url().default("http://localhost:8000"),
  /** Project URL, e.g. https://<ref>.supabase.co. Only needed with VECTOR_STORE=supabase. */
  SUPABASE_URL: z.union([z.literal(""), z.string().url()]).default(""),
  /** Server-only secret key (sb_secret_...). Never ship it to the browser. */
  SUPABASE_SECRET_KEY: z.string().default(""),
  COLLECTION: z.string().min(1).default("kalvora_hr"),
  BATCH_SIZE: z.coerce.number().int().positive().default(64),
});

export interface Endpoint {
  baseUrl: string;
  apiKey: string;
}

export interface Settings {
  /** Absolute corpus path, or "" when CORPUS_DIR is not set. */
  corpusDir: string;
  chat: Endpoint;
  /** Chat model id; empty = auto-pick the first non-embedding model the endpoint lists. */
  chatModel: string;
  embed: Endpoint;
  embedModel: string;
  embedDimensions?: number;
  embedDelayMs: number;
  topK: number;
  docPrefix: string;
  queryPrefix: string;
  vectorStore: "chroma" | "file" | "supabase";
  indexDir: string;
  chromaUrl: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  collection: string;
  batchSize: number;
  chunksPath: string;
}

export function loadSettings(source: NodeJS.ProcessEnv = process.env): Settings {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const env = parsed.data;
  const endpoint = (url: string, key: string): Endpoint => ({
    baseUrl: url || env.LMSTUDIO_BASE_URL,
    apiKey: key || (url ? "" : env.LMSTUDIO_API_KEY),
  });
  return {
    corpusDir: env.CORPUS_DIR ? path.resolve(PROJECT_ROOT, env.CORPUS_DIR) : "",
    chat: endpoint(env.CHAT_BASE_URL, env.CHAT_API_KEY),
    chatModel: env.CHAT_MODEL.trim(),
    embed: endpoint(env.EMBED_BASE_URL, env.EMBED_API_KEY),
    embedModel: env.EMBED_MODEL,
    embedDimensions: env.EMBED_DIMENSIONS,
    embedDelayMs: env.EMBED_DELAY_MS,
    topK: env.TOP_K,
    docPrefix: env.DOC_PREFIX,
    queryPrefix: env.QUERY_PREFIX,
    vectorStore: env.VECTOR_STORE ?? (source.VERCEL ? "supabase" : "chroma"),
    indexDir: path.resolve(PROJECT_ROOT, env.INDEX_DIR),
    chromaUrl: env.CHROMA_URL,
    supabaseUrl: env.SUPABASE_URL.replace(/\/+$/, ""),
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
    collection: env.COLLECTION,
    batchSize: env.BATCH_SIZE,
    chunksPath: path.join(PROJECT_ROOT, "data", "chunks.jsonl"),
  };
}

/** True when the endpoint is a local LM Studio server (enables friendlier model checks). */
export const isLocal = (e: Endpoint) => /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(e.baseUrl);
