/**
 * The vector stores behind one interface:
 *   supabase  Supabase Postgres + pgvector (the deployed app; src/supabaseStore.ts)
 *   chroma    a Chroma server (local development, `npm run chroma`)
 *   file      the in-memory FileIndex in INDEX_DIR (no database; offline or fallback)
 * Pick one with VECTOR_STORE.
 */
import type { Collection, Where } from "chromadb";
import type { Settings } from "./config.js";
import { FileIndex, indexExists } from "./fileIndex.js";
import type { Chunk, Hit } from "./types.js";

/** Chroma is loaded only when used, so the deployed bundle doesn't need it. */
const chroma = () => import("./store.js");
const supabase = () => import("./supabaseStore.js");

/** Read side, used by the retriever. */
export interface SearchStore {
  /** Human-readable location, for logs. */
  label: string;
  /** Vector size the store expects, when known up front (file index). */
  dim?: number;
  search(vector: number[], k: number, countryCode?: string): Promise<Hit[]>;
  count(): Promise<number>;
}

/** Write side, used by the ingestion pipeline. */
export interface IngestStore {
  label: string;
  existingHashes(ids: string[]): Promise<Map<string, string>>;
  upsert(chunks: Chunk[], vectors: number[][]): Promise<void>;
  /**
   * Delete chunks not in `keep`, among the given docs, or among all chunks with "all" (which also
   * removes documents that left the corpus). Returns how many were removed.
   */
  deleteStale(docIds: string[] | "all", keep: Set<string>): Promise<number>;
  /** Persist pending writes (no-op for Chroma, which writes per upsert). */
  flush(): Promise<void>;
  count(): Promise<number>;
}

export async function openSearchStore(settings: Settings): Promise<SearchStore> {
  if (settings.vectorStore === "supabase") return (await supabase()).openSupabaseSearch(settings);
  if (settings.vectorStore === "file") {
    const index = FileIndex.load(settings.indexDir);
    if (index.meta.embedModel !== settings.embedModel) {
      throw new Error(
        `The index in ${settings.indexDir} was built with "${index.meta.embedModel}", but EMBED_MODEL is "${settings.embedModel}".\n` +
          `Set EMBED_MODEL to match, or rebuild the index: npm run ingest -- --reset`,
      );
    }
    return {
      label: `${settings.indexDir} (${index.size} chunks, dim ${index.meta.dim})`,
      dim: index.meta.dim,
      search: async (vector, k, cc) => index.search(vector, k, cc),
      count: async () => index.size,
    };
  }

  const { chromaClient, ensureChromaUp } = await chroma();
  const client = chromaClient(settings);
  await ensureChromaUp(client, settings);
  let col: Collection;
  try {
    col = await client.getCollection({ name: settings.collection });
  } catch {
    throw new Error(`Collection "${settings.collection}" not found. Run the ingestion first: npm run ingest`);
  }
  return {
    label: `Chroma ${settings.chromaUrl} / ${settings.collection}`,
    search: (vector, k, cc) => chromaSearch(col, vector, k, cc ? { country_code: cc } : undefined),
    count: () => col.count(),
  };
}

async function chromaSearch(col: Collection, vector: number[], k: number, where?: Where): Promise<Hit[]> {
  const res = await col.query({
    queryEmbeddings: [vector],
    nResults: k,
    where,
    include: ["documents", "metadatas", "distances"],
  });
  return res.ids[0].map((id, j) => {
    const m = res.metadatas[0][j] ?? {};
    return {
      id,
      text: res.documents[0][j] ?? "",
      docId: String(m.doc_id),
      title: String(m.title),
      country: String(m.country),
      countryCode: String(m.country_code),
      sectionNo: Number(m.section_no),
      sectionTitle: String(m.section_title),
      distance: res.distances[0][j] ?? NaN,
    };
  });
}

/** How many embedding batches to write between saves of the file index (each save rewrites it). */
const FILE_FLUSH_EVERY = 10;

export async function openIngestStore(settings: Settings, dim: number, reset: boolean): Promise<IngestStore> {
  if (settings.vectorStore === "supabase") return (await supabase()).openSupabaseIngest(settings, dim, reset);
  if (settings.vectorStore === "file") {
    const dir = settings.indexDir;
    let index: FileIndex;
    if (indexExists(dir) && !reset) {
      index = FileIndex.load(dir);
      if (index.meta.embedModel !== settings.embedModel || index.meta.dim !== dim) {
        throw new Error(
          `The index in ${dir} was built with "${index.meta.embedModel}" (dim ${index.meta.dim}), ` +
            `but the current model is "${settings.embedModel}" (dim ${dim}).\nRe-run with --reset to rebuild it.`,
        );
      }
    } else {
      index = FileIndex.create({ embedModel: settings.embedModel, dim, docPrefix: settings.docPrefix, queryPrefix: settings.queryPrefix });
    }
    let pending = 0;
    const flush = async () => {
      index.save(dir);
      pending = 0;
    };
    return {
      label: dir,
      existingHashes: async (ids) => {
        const all = index.hashes();
        return new Map(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)!]));
      },
      upsert: async (chunks, vectors) => {
        index.upsert(chunks, vectors);
        if (++pending >= FILE_FLUSH_EVERY) await flush(); // progress survives a crash or a rate-limit abort
      },
      deleteStale: async (docIds, keep) => index.deleteStale(docIds, keep),
      flush,
      count: async () => index.size,
    };
  }

  const { chromaClient, deleteStale, ensureChromaUp, existingHashes, openCollection, upsertChunks } = await chroma();
  const client = chromaClient(settings);
  await ensureChromaUp(client, settings);
  const col = await openCollection(client, settings, dim, reset);
  return {
    label: `Chroma collection "${settings.collection}"`,
    existingHashes: (ids) => existingHashes(col, ids),
    upsert: (chunks, vectors) => upsertChunks(col, chunks, vectors),
    deleteStale: (docIds, keep) => deleteStale(col, docIds, keep),
    flush: async () => {},
    count: () => col.count(),
  };
}
