/** Structural check of the local file index in data/index (skipped when absent, e.g. in CI; no network). */
import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { FileIndex, indexExists } from "../src/fileIndex.js";
import { COUNTRY_CODES } from "../src/retriever.js";

const dir = loadSettings({}).indexDir;

describe.skipIf(!indexExists(dir))("local file vector index", () => {
  const index = FileIndex.load(dir);

  it("has every chunk, country and section", () => {
    expect(index.size).toBe(7500);
    const hashes = index.hashes();
    expect(hashes.size).toBe(7500);
    const hit = index.search(new Array(index.meta.dim).fill(0.1), 7500);
    expect(new Set(hit.map((h) => h.countryCode))).toEqual(new Set(COUNTRY_CODES));
    expect(new Set(hit.map((h) => h.sectionNo)).size).toBe(15);
    expect(hit.every((h) => h.text && h.docId && h.title && Number.isFinite(h.distance))).toBe(true);
  });

  it("records the embedding model it was built with", () => {
    expect(index.meta.embedModel).toBeTruthy();
    expect(index.meta.dim).toBeGreaterThan(0);
  });
});
