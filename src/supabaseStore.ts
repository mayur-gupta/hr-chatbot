/**
 * Supabase Postgres + pgvector vector store (VECTOR_STORE=supabase, the default on Vercel).
 * Schema: supabase/migrations/*_kalvora_vector_store.sql.
 *
 * Access is server-only. The tables have RLS with no policies and the search function is granted
 * only to service_role, so this needs SUPABASE_SECRET_KEY (sb_secret_...). Never expose that key
 * to the browser; the UI only ever talks to our own /api.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Settings } from "./config.js";
import type { Chunk, ChunkMetadata, Hit } from "./types.js";
import type { IngestStore, SearchStore } from "./vectorStore.js";

/** Size of the embedding column (vector(768)). Change it together with the migration. */
export const SCHEMA_DIM = 768;
const CHUNKS = "kalvora_chunks";
const META = "kalvora_index_meta";
const MATCH_FN = "match_kalvora_chunks";
/** Ids per DELETE ... WHERE id IN (...) request, to keep the URL short. */
const DELETE_BATCH = 100;

interface IndexMeta {
  embed_model: string;
  dim: number;
  doc_prefix: string;
  query_prefix: string;
}

/** A row returned by match_kalvora_chunks. */
export interface MatchRow {
  id: string;
  text: string;
  metadata: ChunkMetadata;
  distance: number;
}

interface ListedRow {
  id: string;
  doc_id: string;
  content_hash: string;
}

type Result<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;

/** Await a supabase-js query and throw on error. */
async function run<T>(query: Result<T>, what: string): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`Supabase: ${what} failed: ${error.message}`);
  return data as T;
}

/** pgvector's text format, e.g. "[0.1,0.2]". Sent as a string so PostgREST casts it with vector_in. */
export const toVector = (v: number[]) => `[${v.join(",")}]`;

export function rowToHit(r: MatchRow): Hit {
  const m = r.metadata;
  return {
    id: r.id,
    text: r.text,
    docId: String(m.doc_id),
    title: String(m.title),
    country: String(m.country),
    countryCode: String(m.country_code),
    sectionNo: Number(m.section_no),
    sectionTitle: String(m.section_title),
    distance: Number(r.distance),
  };
}

export function chunkRow(c: Chunk, vector: number[]) {
  return {
    id: c.id,
    doc_id: c.metadata.doc_id,
    country_code: c.metadata.country_code,
    content_hash: c.metadata.content_hash,
    text: c.text,
    metadata: c.metadata,
    embedding: toVector(vector),
    updated_at: new Date().toISOString(),
  };
}

/** Ids of chunks that belong to the re-ingested docs (or to any doc, with "all") but are no longer produced. */
export function staleIds(rows: ListedRow[], docIds: string[] | "all", keep: Set<string>): string[] {
  const docs = docIds === "all" ? null : new Set(docIds);
  return rows.filter((r) => (!docs || docs.has(r.doc_id)) && !keep.has(r.id)).map((r) => r.id);
}

function connect(settings: Settings): SupabaseClient {
  if (!settings.supabaseUrl || !settings.supabaseSecretKey) {
    throw new Error(
      "VECTOR_STORE=supabase needs SUPABASE_URL and SUPABASE_SECRET_KEY " +
        "(the sb_secret_... key from Supabase > Project Settings > API Keys)",
    );
  }
  return createClient(settings.supabaseUrl, settings.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const label = (settings: Settings) => `Supabase ${new URL(settings.supabaseUrl).hostname}`;

async function readMeta(db: SupabaseClient, settings: Settings): Promise<IndexMeta | null> {
  try {
    return await run<IndexMeta | null>(
      db.from(META).select("embed_model, dim, doc_prefix, query_prefix").eq("id", 1).maybeSingle(),
      "reading the index metadata",
    );
  } catch (err) {
    throw new Error(
      `${(err as Error).message}\nCheck SUPABASE_URL (${settings.supabaseUrl}) and SUPABASE_SECRET_KEY, that the migration in ` +
        `supabase/migrations has been applied, and that the project isn't paused (free projects pause after a week without use).`,
    );
  }
}

async function countRows(db: SupabaseClient): Promise<number> {
  const { count, error } = await db.from(CHUNKS).select("id", { count: "exact", head: true });
  if (error) throw new Error(`Supabase: counting chunks failed: ${error.message}`);
  return count ?? 0;
}

/** id, doc_id and content_hash of every chunk, paged (PostgREST caps rows per request). */
async function listRows(db: SupabaseClient): Promise<ListedRow[]> {
  const out: ListedRow[] = [];
  for (;;) {
    const page = await run<ListedRow[]>(
      db.from(CHUNKS).select("id, doc_id, content_hash").order("id").range(out.length, out.length + 999),
      "listing chunks",
    );
    if (!page.length) return out;
    out.push(...page);
  }
}

export async function openSupabaseSearch(settings: Settings): Promise<SearchStore> {
  const db = connect(settings);
  const meta = await readMeta(db, settings);
  if (!meta) throw new Error(`The Supabase vector store is empty. Build it with: VECTOR_STORE=supabase npm run ingest`);
  if (meta.embed_model !== settings.embedModel) {
    throw new Error(
      `The Supabase index was built with "${meta.embed_model}", but EMBED_MODEL is "${settings.embedModel}".\n` +
        `Set EMBED_MODEL to match, or rebuild it: VECTOR_STORE=supabase npm run ingest -- --reset`,
    );
  }
  return {
    label: `${label(settings)} (dim ${meta.dim})`,
    dim: meta.dim,
    search: async (vector, k, countryCode) => {
      const rows = await run<MatchRow[]>(
        db.rpc(MATCH_FN, { query_embedding: toVector(vector), match_count: k, filter_country: countryCode ?? null }),
        "vector search",
      );
      return rows.map(rowToHit);
    },
    count: () => countRows(db),
  };
}

export async function openSupabaseIngest(settings: Settings, dim: number, reset: boolean): Promise<IngestStore> {
  if (dim !== SCHEMA_DIM) {
    throw new Error(
      `The embedding model returns ${dim}-dim vectors, but the Supabase column is vector(${SCHEMA_DIM}).\n` +
        `Set EMBED_DIMENSIONS=${SCHEMA_DIM}, or change the column size in supabase/migrations and SCHEMA_DIM.`,
    );
  }
  const db = connect(settings);
  const meta = await readMeta(db, settings);
  if (reset) {
    await run(db.from(CHUNKS).delete().neq("id", ""), "clearing the chunks (--reset)");
  } else if (meta && (meta.embed_model !== settings.embedModel || meta.dim !== dim)) {
    throw new Error(
      `The Supabase index was built with "${meta.embed_model}" (dim ${meta.dim}), ` +
        `but the current model is "${settings.embedModel}" (dim ${dim}).\nRe-run with --reset to rebuild it.`,
    );
  }
  await run(
    db.from(META).upsert({
      id: 1,
      embed_model: settings.embedModel,
      dim,
      doc_prefix: settings.docPrefix,
      query_prefix: settings.queryPrefix,
      updated_at: new Date().toISOString(),
    }),
    "writing the index metadata",
  );

  return {
    label: label(settings),
    existingHashes: async (ids) => {
      const wanted = new Set(ids);
      return new Map((await listRows(db)).filter((r) => wanted.has(r.id)).map((r) => [r.id, r.content_hash]));
    },
    // Written per batch, so progress survives a crash or a rate-limit abort.
    upsert: async (chunks, vectors) => {
      await run(db.from(CHUNKS).upsert(chunks.map((c, i) => chunkRow(c, vectors[i]))), "upserting chunks");
    },
    deleteStale: async (docIds, keep) => {
      const stale = staleIds(await listRows(db), docIds, keep);
      for (let i = 0; i < stale.length; i += DELETE_BATCH) {
        await run(db.from(CHUNKS).delete().in("id", stale.slice(i, i + DELETE_BATCH)), "deleting stale chunks");
      }
      return stale.length;
    },
    flush: async () => {},
    count: () => countRows(db),
  };
}
