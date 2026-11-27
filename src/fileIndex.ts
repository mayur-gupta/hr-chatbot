/**
 * A vector index stored as two files, searched in memory by brute force. The corpus is small
 * (7,500 chunks), so scoring every chunk takes a few milliseconds and no database is needed.
 * This is what the deployed app uses: the index ships with the code.
 *
 *   index.json   meta + one entry per chunk (text and the metadata the app shows)
 *   vectors.bin  int8 vectors, `dim` bytes per entry, in entry order
 *
 * Each vector is L2-normalised, then quantised to int8 with its own scale, which keeps the
 * file at ~1 byte per dimension with negligible effect on ranking.
 */
import fs from "node:fs";
import path from "node:path";
import type { Chunk, Hit } from "./types.js";

export interface IndexMeta {
  version: 1;
  embedModel: string;
  dim: number;
  docPrefix: string;
  queryPrefix: string;
  updatedAt: string;
}

export interface IndexEntry {
  id: string;
  text: string;
  docId: string;
  title: string;
  country: string;
  countryCode: string;
  sectionNo: number;
  sectionTitle: string;
  /** content_hash of the chunk, so re-ingestion only re-embeds what changed. */
  hash: string;
  /** Multiply the int8 dot product by this to get the cosine similarity. */
  scale: number;
}

const JSON_FILE = "index.json";
const BIN_FILE = "vectors.bin";

export function indexExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, JSON_FILE)) && fs.existsSync(path.join(dir, BIN_FILE));
}

/** Normalise and quantise one vector. */
export function quantize(v: ArrayLike<number>): { row: Int8Array; scale: number } {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i] / norm));
  max ||= 1;
  const row = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) row[i] = Math.round((v[i] / norm / max) * 127);
  return { row, scale: max / 127 };
}

function normalize(v: ArrayLike<number>): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export class FileIndex {
  private entries: IndexEntry[] = [];
  private rows: Int8Array[] = [];
  private pos = new Map<string, number>();

  private constructor(public meta: IndexMeta) {}

  static create(meta: Omit<IndexMeta, "version" | "updatedAt">): FileIndex {
    return new FileIndex({ version: 1, ...meta, updatedAt: new Date().toISOString() });
  }

  static load(dir: string): FileIndex {
    if (!indexExists(dir)) {
      throw new Error(`No vector index in ${dir}. Build it with: npm run ingest (with VECTOR_STORE=file)`);
    }
    const { meta, entries } = JSON.parse(fs.readFileSync(path.join(dir, JSON_FILE), "utf8")) as {
      meta: IndexMeta;
      entries: IndexEntry[];
    };
    if (meta.version !== 1) throw new Error(`Unsupported index version ${meta.version} in ${dir}`);
    const buf = fs.readFileSync(path.join(dir, BIN_FILE));
    if (buf.length !== entries.length * meta.dim) {
      throw new Error(`Corrupt index in ${dir}: ${BIN_FILE} has ${buf.length} bytes, expected ${entries.length * meta.dim}`);
    }
    const all = new Int8Array(buf.buffer, buf.byteOffset, buf.length);
    const index = new FileIndex(meta);
    index.entries = entries;
    index.rows = entries.map((_, i) => all.subarray(i * meta.dim, (i + 1) * meta.dim));
    index.reindex();
    return index;
  }

  private reindex(): void {
    this.pos = new Map(this.entries.map((e, i) => [e.id, i]));
  }

  get size(): number {
    return this.entries.length;
  }

  hashes(): Map<string, string> {
    return new Map(this.entries.map((e) => [e.id, e.hash]));
  }

  upsert(chunks: Chunk[], vectors: number[][]): void {
    chunks.forEach((c, j) => {
      if (vectors[j].length !== this.meta.dim) {
        throw new Error(`vector for ${c.id} has ${vectors[j].length} dimensions, index expects ${this.meta.dim}`);
      }
      const { row, scale } = quantize(vectors[j]);
      const m = c.metadata;
      const entry: IndexEntry = {
        id: c.id,
        text: c.text,
        docId: m.doc_id,
        title: m.title,
        country: m.country,
        countryCode: m.country_code,
        sectionNo: m.section_no,
        sectionTitle: m.section_title,
        hash: m.content_hash,
        scale,
      };
      const at = this.pos.get(c.id);
      if (at === undefined) {
        this.pos.set(c.id, this.entries.length);
        this.entries.push(entry);
        this.rows.push(row);
      } else {
        this.entries[at] = entry;
        this.rows[at] = row;
      }
    });
  }

  /** Remove chunks of the given docs (or of any doc, with "all") that are not in `keep`. Returns how many were removed. */
  deleteStale(docIds: string[] | "all", keep: Set<string>): number {
    const docs = docIds === "all" ? null : new Set(docIds);
    const drop = this.entries.map((e) => (!docs || docs.has(e.docId)) && !keep.has(e.id));
    const removed = drop.filter(Boolean).length;
    if (removed) {
      this.entries = this.entries.filter((_, i) => !drop[i]);
      this.rows = this.rows.filter((_, i) => !drop[i]);
      this.reindex();
    }
    return removed;
  }

  /** Top-k entries by cosine similarity, optionally limited to one country. */
  search(vector: ArrayLike<number>, k: number, countryCode?: string): Hit[] {
    if (vector.length !== this.meta.dim) {
      throw new Error(`query vector has ${vector.length} dimensions, index expects ${this.meta.dim} (was it built with another model?)`);
    }
    const q = normalize(vector);
    const scored: { i: number; score: number }[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (countryCode && e.countryCode !== countryCode) continue;
      const row = this.rows[i];
      let dot = 0;
      for (let d = 0; d < row.length; d++) dot += q[d] * row[d];
      scored.push({ i, score: dot * e.scale });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(({ i, score }) => {
      const { hash: _h, scale: _s, ...e } = this.entries[i];
      return { ...e, distance: 1 - score };
    });
  }

  /** Write both files atomically (temp file + rename), so a crash never leaves a half-written index. */
  save(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    this.meta.updatedAt = new Date().toISOString();
    const bin = Buffer.alloc(this.entries.length * this.meta.dim);
    this.rows.forEach((r, i) => bin.set(new Uint8Array(r.buffer, r.byteOffset, r.length), i * this.meta.dim));
    const json = JSON.stringify({ meta: this.meta, entries: this.entries });
    for (const [file, data] of [[BIN_FILE, bin], [JSON_FILE, json]] as const) {
      const target = path.join(dir, file);
      fs.writeFileSync(`${target}.tmp`, data);
      fs.renameSync(`${target}.tmp`, target);
    }
  }
}
