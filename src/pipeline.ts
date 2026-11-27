import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import cliProgress from "cli-progress";
import { loadSettings } from "./config.js";
import { loadManifest } from "./manifest.js";
import { parseDocx } from "./parser.js";
import { chunkDocument } from "./chunker.js";
import { Embedder } from "./embedder.js";
import { openIngestStore } from "./vectorStore.js";
import type { Chunk } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Options {
  country?: string;
  limit?: number;
  dryRun: boolean;
  reset: boolean;
  prune: boolean;
}

const program = new Command()
  .name("ingest")
  .description("Ingest the Kalvora HR policy corpus into the vector store (Supabase, Chroma or the file index)")
  .option("-c, --country <code>", "only ingest one country code (e.g. GB, IN)")
  .option("-l, --limit <n>", "only ingest the first N documents", (v) => parseInt(v, 10))
  .option("--dry-run", "parse + chunk + write data/chunks.jsonl; no embedding or DB writes", false)
  .option("--reset", "drop and rebuild the collection / index", false)
  .option("--prune", "also delete chunks of documents that are no longer in the corpus (full runs only)", false);

async function main(): Promise<void> {
  const opts = program.parse().opts<Options>();
  const settings = loadSettings();
  const t0 = Date.now();
  if (!settings.corpusDir) throw new Error("CORPUS_DIR is required for ingestion (see .env.example)");
  if (opts.prune && (opts.country || opts.limit)) {
    throw new Error("--prune syncs the store to the whole corpus, so it can't be combined with --country or --limit");
  }

  // 1. Discover
  const { records: all, warnings } = loadManifest(settings.corpusDir);
  warnings.forEach((w) => console.warn(`WARN ${w}`));
  const titles = new Map(all.map((r) => [r.meta.doc_id, r.meta.title]));
  let records = all;
  if (opts.country) records = records.filter((r) => r.meta.country_code.toUpperCase() === opts.country!.toUpperCase());
  if (opts.limit) records = records.slice(0, opts.limit);
  console.log(`Corpus: ${settings.corpusDir}`);
  console.log(`Documents selected: ${records.length} of ${all.length}`);
  if (!records.length) return;

  // 2-3. Parse + chunk (failures are logged, not fatal)
  const chunks: Chunk[] = [];
  const failures: { file: string; error: string }[] = [];
  const docChunkIds = new Map<string, Set<string>>();
  for (const rec of records) {
    try {
      const blocks = await parseDocx(rec.absPath);
      const docChunks = chunkDocument(rec.meta, blocks, rec.meta.file_path, { embedModel: settings.embedModel, titles });
      chunks.push(...docChunks);
      docChunkIds.set(rec.meta.doc_id, new Set(docChunks.map((c) => c.id)));
    } catch (err) {
      failures.push({ file: rec.meta.file_path, error: (err as Error).message });
    }
  }
  const sectionCounts = [...docChunkIds.values()].map((s) => s.size);
  console.log(
    `Parsed: ${docChunkIds.size} docs, ${failures.length} failed | Chunks: ${chunks.length} ` +
      `(${Math.min(...sectionCounts)}-${Math.max(...sectionCounts)} per doc)`,
  );

  // 7a. Artifact for inspection / evals
  fs.mkdirSync(path.dirname(settings.chunksPath), { recursive: true });
  fs.writeFileSync(settings.chunksPath, chunks.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");
  console.log(`Wrote ${settings.chunksPath}`);

  if (opts.dryRun) {
    report(failures, t0);
    return;
  }

  // 5. Embedder health check
  const embedder = new Embedder(settings);
  const dim = await embedder.healthCheck();
  console.log(`Embeddings OK: ${settings.embedModel} at ${settings.embed.baseUrl} (dim ${dim})`);

  // 6. Store
  const store = await openIngestStore(settings, dim, opts.reset);
  console.log(`Store: ${store.label}`);

  const existing = await store.existingHashes(chunks.map((c) => c.id));
  const todo = chunks.filter((c) => existing.get(c.id) !== c.metadata.content_hash);
  const created = todo.filter((c) => !existing.has(c.id)).length;
  const updated = todo.length - created;
  console.log(`To embed: ${todo.length} (new ${created}, changed ${updated}), unchanged ${chunks.length - todo.length}`);

  if (todo.length) {
    const bar = new cliProgress.SingleBar({ format: "Embedding [{bar}] {value}/{total} chunks | ETA {eta}s" }, cliProgress.Presets.shades_classic);
    bar.start(todo.length, 0);
    for (let i = 0; i < todo.length; i += settings.batchSize) {
      const batch = todo.slice(i, i + settings.batchSize);
      const vectors = await embedder.embedDocuments(batch.map((c) => c.text));
      await store.upsert(batch, vectors); // per batch, so progress survives a crash
      bar.increment(batch.length);
      if (settings.embedDelayMs && i + settings.batchSize < todo.length) await sleep(settings.embedDelayMs);
    }
    bar.stop();
  }

  const keep = new Set(chunks.map((c) => c.id));
  // A doc that failed to parse has no chunks in `keep`; pruning would delete its existing vectors.
  const prune = opts.prune && !failures.length;
  if (opts.prune && !prune) console.warn(`WARN --prune skipped: ${failures.length} documents failed to parse`);
  const removed = await store.deleteStale(prune ? "all" : [...docChunkIds.keys()], keep);
  await store.flush();
  console.log(`Stale chunks deleted: ${removed}`);
  console.log(`${store.label} now holds ${await store.count()} chunks`);
  report(failures, t0);
}

function report(failures: { file: string; error: string }[], t0: number): void {
  for (const f of failures) console.error(`FAILED ${f.file}: ${f.error}`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s${failures.length ? ` with ${failures.length} failures` : ""}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nERROR: ${(err as Error).message}`);
  process.exit(1);
});
