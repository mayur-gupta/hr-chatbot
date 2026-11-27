/**
 * Copy a Chroma collection into the file index, without re-embedding:
 *   npm run export-index
 * Useful to switch an existing local setup to VECTOR_STORE=file. For the free hosted setup,
 * build the index with hosted embeddings instead (VECTOR_STORE=file npm run ingest -- --reset),
 * because query vectors must come from the same model as the index.
 */
import { loadSettings } from "./config.js";
import { FileIndex } from "./fileIndex.js";
import { chromaClient, ensureChromaUp } from "./store.js";
import type { Chunk, ChunkMetadata } from "./types.js";

const PAGE = 500;

const settings = loadSettings();
const client = chromaClient(settings);
await ensureChromaUp(client, settings);
const col = await client.getCollection({ name: settings.collection });
const total = await col.count();
const embedModel = String(col.metadata?.embed_model ?? settings.embedModel);
let index: FileIndex | null = null;

for (let offset = 0; offset < total; offset += PAGE) {
  const res = await col.get({ limit: PAGE, offset, include: ["documents", "metadatas", "embeddings"] });
  const chunks: Chunk[] = res.ids.map((id, j) => ({ id, text: res.documents[j] ?? "", metadata: res.metadatas[j] as ChunkMetadata }));
  const vectors = res.embeddings.map((e) => Array.from(e as ArrayLike<number>));
  index ??= FileIndex.create({ embedModel, dim: vectors[0].length, docPrefix: settings.docPrefix, queryPrefix: settings.queryPrefix });
  index.upsert(chunks, vectors);
  process.stdout.write(`\rExported ${Math.min(offset + PAGE, total)}/${total}`);
}
if (!index) throw new Error(`Collection "${settings.collection}" is empty`);
index.save(settings.indexDir);
console.log(`\nWrote ${index.size} chunks (model ${embedModel}, dim ${index.meta.dim}) to ${settings.indexDir}`);
