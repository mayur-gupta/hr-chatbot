import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileIndex, quantize } from "../src/fileIndex.js";
import type { Chunk } from "../src/types.js";

const DIM = 64;

/** Deterministic pseudo-random vectors (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}
const rand = rng(42);
const vec = () => Array.from({ length: DIM }, rand);

function chunk(id: string, cc = "GB", hash = "h1"): Chunk {
  const docId = id.split("::")[0];
  return {
    id,
    text: `text of ${id}`,
    metadata: {
      doc_id: docId, title: `Title ${docId}`, country: cc, country_code: cc, legal_entity: "", category: "", policy_number: 1,
      topic_code: "", version: "1", effective_date: "", last_reviewed: "", section_no: 6, section_title: "6. Section",
      is_country_specific: true, related_doc_ids: "", source_path: "", content_hash: hash, embed_model: "m",
    },
  };
}

const cosine = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return d / Math.sqrt(na * nb);
};

const newIndex = () => FileIndex.create({ embedModel: "m", dim: DIM, docPrefix: "", queryPrefix: "" });

describe("quantize", () => {
  it("keeps cosine similarity within 0.01", () => {
    for (let n = 0; n < 50; n++) {
      const a = vec(), b = vec();
      const { row, scale } = quantize(b);
      const an = Math.hypot(...a);
      const approx = a.reduce((s, x, i) => s + (x / an) * row[i], 0) * scale;
      expect(Math.abs(approx - cosine(a, b))).toBeLessThan(0.01);
    }
  });
});

describe("FileIndex", () => {
  const chunks = Array.from({ length: 200 }, (_, i) => chunk(`KAL-${i % 2 ? "DE" : "GB"}-HR-${i}::s06`, i % 2 ? "DE" : "GB"));
  const vectors = chunks.map(vec);

  it("ranks like exact cosine search", () => {
    const index = newIndex();
    index.upsert(chunks, vectors);
    for (let n = 0; n < 20; n++) {
      const q = vec();
      const exact = vectors.map((v, i) => ({ id: chunks[i].id, s: cosine(q, v) })).sort((a, b) => b.s - a.s);
      const hits = index.search(q, 5);
      expect(hits[0].id).toBe(exact[0].id);
      expect(hits[0].distance).toBeCloseTo(1 - exact[0].s, 2);
      expect(hits.map((h) => h.distance)).toEqual([...hits.map((h) => h.distance)].sort((a, b) => a - b));
    }
  });

  it("filters by country and limits to k", () => {
    const index = newIndex();
    index.upsert(chunks, vectors);
    const hits = index.search(vec(), 7, "DE");
    expect(hits).toHaveLength(7);
    expect(hits.every((h) => h.countryCode === "DE")).toBe(true);
    expect(hits[0]).not.toHaveProperty("hash");
  });

  it("replaces on upsert and deletes stale chunks", () => {
    const index = newIndex();
    index.upsert([chunk("A::s01"), chunk("A::s02"), chunk("B::s01")], [vec(), vec(), vec()]);
    index.upsert([chunk("A::s01", "GB", "h2")], [vec()]);
    expect(index.size).toBe(3);
    expect(index.hashes().get("A::s01")).toBe("h2");
    expect(index.deleteStale(["A"], new Set(["A::s01"]))).toBe(1);
    expect([...index.hashes().keys()].sort()).toEqual(["A::s01", "B::s01"]);
  });

  it("round-trips through save/load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kal-index-"));
    try {
      const index = newIndex();
      index.upsert(chunks, vectors);
      index.save(dir);
      const loaded = FileIndex.load(dir);
      const q = vec();
      expect(loaded.size).toBe(chunks.length);
      expect(loaded.meta.embedModel).toBe("m");
      expect(loaded.search(q, 5)).toEqual(index.search(q, 5));
      // Loaded indexes stay writable (incremental re-ingest).
      loaded.upsert([chunk("NEW::s01")], [vec()]);
      loaded.save(dir);
      expect(FileIndex.load(dir).size).toBe(chunks.length + 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects vectors of the wrong size", () => {
    const index = newIndex();
    expect(() => index.upsert([chunk("A::s01")], [[1, 2, 3]])).toThrow(/dimensions/);
    expect(() => index.search([1, 2, 3], 5)).toThrow(/dimensions/);
  });
});
