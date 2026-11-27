import { ChromaClient, type Collection } from "chromadb";
import type { Settings } from "./config.js";
import type { Chunk } from "./types.js";

const READ_PAGE = 500;

export function chromaClient(settings: Settings): ChromaClient {
  const url = new URL(settings.chromaUrl);
  const ssl = url.protocol === "https:";
  return new ChromaClient({ host: url.hostname, port: Number(url.port || (ssl ? 443 : 80)), ssl });
}

export async function ensureChromaUp(client: ChromaClient, settings: Settings): Promise<void> {
  try {
    await client.heartbeat();
  } catch (err) {
    throw new Error(
      `Cannot reach Chroma at ${settings.chromaUrl} (${(err as Error).message}).\n` +
        `Start it in another terminal with: npm run chroma`,
    );
  }
}

/** Open (or create) the collection, refusing to mix embedding models or dimensions. */
export async function openCollection(
  client: ChromaClient,
  settings: Settings,
  dimension: number,
  reset: boolean,
): Promise<Collection> {
  const name = settings.collection;
  const existing = (await client.listCollections()).some((c) => c.name === name);

  if (existing && reset) {
    await client.deleteCollection({ name });
  } else if (existing) {
    const col = await client.getCollection({ name });
    const meta = col.metadata ?? {};
    if (meta.embed_model !== settings.embedModel || Number(meta.embed_dim) !== dimension) {
      throw new Error(
        `Collection "${name}" was built with model "${meta.embed_model}" (dim ${meta.embed_dim}), ` +
          `but the current model is "${settings.embedModel}" (dim ${dimension}).\n` +
          `Re-run with --reset to rebuild it.`,
      );
    }
    return col;
  }

  return client.createCollection({
    name,
    embeddingFunction: null,
    configuration: { hnsw: { space: "cosine" } },
    metadata: { embed_model: settings.embedModel, embed_dim: dimension, source: "Kalvora HR Policies" },
  });
}

/** id -> content_hash for the given ids that already exist. */
export async function existingHashes(col: Collection, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += READ_PAGE) {
    const res = await col.get({ ids: ids.slice(i, i + READ_PAGE), include: ["metadatas"] });
    res.ids.forEach((id, j) => {
      const hash = res.metadatas[j]?.content_hash;
      if (typeof hash === "string") out.set(id, hash);
    });
  }
  return out;
}

export async function upsertChunks(col: Collection, chunks: Chunk[], embeddings: number[][]): Promise<void> {
  await col.upsert({
    ids: chunks.map((c) => c.id),
    embeddings,
    documents: chunks.map((c) => c.text),
    metadatas: chunks.map((c) => c.metadata),
  });
}

/** Delete chunks of the given docs (or of any doc, with "all") that are no longer produced. Returns how many were removed. */
export async function deleteStale(col: Collection, docIds: string[] | "all", keep: Set<string>): Promise<number> {
  if (docIds === "all") {
    const stale: string[] = [];
    for (let offset = 0; ; offset += READ_PAGE) {
      const res = await col.get({ include: [], limit: READ_PAGE, offset });
      stale.push(...res.ids.filter((id) => !keep.has(id)));
      if (res.ids.length < READ_PAGE) break;
    }
    for (let i = 0; i < stale.length; i += READ_PAGE) await col.delete({ ids: stale.slice(i, i + READ_PAGE) });
    return stale.length;
  }
  let removed = 0;
  for (let i = 0; i < docIds.length; i += 50) {
    const batch = docIds.slice(i, i + 50);
    const res = await col.get({ where: { doc_id: { $in: batch } }, include: [] });
    const stale = res.ids.filter((id) => !keep.has(id));
    if (stale.length) {
      await col.delete({ ids: stale });
      removed += stale.length;
    }
  }
  return removed;
}
