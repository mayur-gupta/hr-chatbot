/** Supabase store: row mapping and guards that run before any network call. */
import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { chunkRow, openSupabaseIngest, openSupabaseSearch, rowToHit, SCHEMA_DIM, staleIds, toVector } from "../src/supabaseStore.js";
import type { Chunk, ChunkMetadata } from "../src/types.js";

const metadata = {
  doc_id: "KAL-GB-HR-017",
  title: "Family Leave Policy",
  country: "United Kingdom",
  country_code: "GB",
  section_no: 6,
  section_title: "Partner leave",
  content_hash: "abc123",
} as unknown as ChunkMetadata;

describe("supabase store", () => {
  it("formats vectors in pgvector's text format", () => {
    expect(toVector([0.5, -1, 2e-7])).toBe("[0.5,-1,2e-7]");
  });

  it("maps a chunk to a table row with the filter columns pulled out", () => {
    const chunk: Chunk = { id: "KAL-GB-HR-017#6", text: "Partners get two weeks.", metadata };
    const row = chunkRow(chunk, [0.1, 0.2]);
    expect(row).toMatchObject({
      id: "KAL-GB-HR-017#6",
      doc_id: "KAL-GB-HR-017",
      country_code: "GB",
      content_hash: "abc123",
      text: "Partners get two weeks.",
      metadata,
      embedding: "[0.1,0.2]",
    });
  });

  it("maps a search row to a Hit", () => {
    expect(rowToHit({ id: "x", text: "t", metadata, distance: 0.25 })).toEqual({
      id: "x",
      text: "t",
      docId: "KAL-GB-HR-017",
      title: "Family Leave Policy",
      country: "United Kingdom",
      countryCode: "GB",
      sectionNo: 6,
      sectionTitle: "Partner leave",
      distance: 0.25,
    });
  });

  it("deletes only chunks of re-ingested docs that are no longer produced", () => {
    const rows = [
      { id: "A#1", doc_id: "A", content_hash: "h" },
      { id: "A#2", doc_id: "A", content_hash: "h" },
      { id: "B#1", doc_id: "B", content_hash: "h" },
    ];
    expect(staleIds(rows, ["A"], new Set(["A#1"]))).toEqual(["A#2"]);
  });

  it("with 'all', also deletes chunks of docs that left the corpus", () => {
    const rows = [
      { id: "A#1", doc_id: "A", content_hash: "h" },
      { id: "A#2", doc_id: "A", content_hash: "h" },
      { id: "B#1", doc_id: "B", content_hash: "h" },
    ];
    expect(staleIds(rows, "all", new Set(["A#1"]))).toEqual(["A#2", "B#1"]);
  });

  it("needs the URL and secret key", async () => {
    await expect(openSupabaseSearch(loadSettings({ VECTOR_STORE: "supabase" }))).rejects.toThrow(/SUPABASE_SECRET_KEY/);
  });

  it("refuses vectors that don't fit the column, before connecting", async () => {
    const s = loadSettings({ VECTOR_STORE: "supabase", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SECRET_KEY: "k" });
    await expect(openSupabaseIngest(s, SCHEMA_DIM * 4, false)).rejects.toThrow(/EMBED_DIMENSIONS=768/);
  });
});
