import { describe, expect, it } from "vitest";
import { chunkDocument, parseHeading, splitBody } from "../src/chunker.js";
import type { Block, DocMeta } from "../src/types.js";

const meta: DocMeta = {
  doc_id: "KAL-GB-HR-016", file_path: "United Kingdom/x.docx", title: "Maternity Leave Policy",
  country: "United Kingdom", country_code: "GB", legal_entity: "Kalvora Technologies UK Limited",
  category: "Leave & Time Off", policy_number: 16, topic_code: "MAT", version: "1.2",
  effective_date: "2025-10-17", last_reviewed: "2026-01-20", next_review: "2027-01-20",
  review_cycle: "Annually", policy_owner: "Owner", approved_by: "Approver",
  related_doc_ids: ["KAL-GB-HR-017", "KAL-GB-HR-099"], word_count: 1300,
};
const blocks: Block[] = [
  { type: "heading", text: "1. Purpose" }, { type: "para", text: "Purpose text." },
  { type: "heading", text: "6. Country-Specific Provisions: United Kingdom" }, { type: "para", text: "52 weeks." },
  { type: "heading", text: "14. Review and Document Control" }, { type: "para", text: "Owned by HR." },
  { type: "table", text: "| Version | Date |\n| --- | --- |\n| 1.0 | 2020 |" },
];
const opts = { embedModel: "test-model", titles: new Map([["KAL-GB-HR-017", "Paternity and Partner Leave Policy"]]) };

describe("chunkDocument", () => {
  const chunks = chunkDocument(meta, blocks, meta.file_path, opts);

  it("emits a summary chunk plus one chunk per section with deterministic ids", () => {
    expect(chunks.map((c) => c.id)).toEqual([
      "KAL-GB-HR-016::s00", "KAL-GB-HR-016::s01", "KAL-GB-HR-016::s06", "KAL-GB-HR-016::s14",
    ]);
  });

  it("prepends the country/policy header", () => {
    expect(chunks[2].text.startsWith(
      "Kalvora HR Policy | Country: United Kingdom (GB) | Policy: Maternity Leave Policy (KAL-GB-HR-016)\n" +
      "Category: Leave & Time Off | Section 6: Country-Specific Provisions: United Kingdom"
    )).toBe(true);
  });

  it("keeps the revision table with section 14 and names related policies in the summary", () => {
    expect(chunks[3].text).toContain("| 1.0 | 2020 |");
    expect(chunks[0].text).toContain("KAL-GB-HR-017: Paternity and Partner Leave Policy");
    expect(chunks[0].text).toContain("KAL-GB-HR-099: (unknown)");
  });

  it("uses only scalar metadata and flags section 6", () => {
    for (const c of chunks) {
      for (const v of Object.values(c.metadata)) expect(["string", "number", "boolean"]).toContain(typeof v);
    }
    expect(chunks.filter((c) => c.metadata.is_country_specific).map((c) => c.id)).toEqual(["KAL-GB-HR-016::s06"]);
    expect(chunks[1].metadata.related_doc_ids).toBe("KAL-GB-HR-017;KAL-GB-HR-099");
  });

  it("changes the hash when the model changes", () => {
    const other = chunkDocument(meta, blocks, meta.file_path, { ...opts, embedModel: "other" });
    expect(other[1].metadata.content_hash).not.toBe(chunks[1].metadata.content_hash);
  });
});

describe("helpers", () => {
  it("parses numbered headings", () => {
    expect(parseHeading("6. Country-Specific Provisions: India", 1)).toEqual({ no: 6, title: "Country-Specific Provisions: India" });
    expect(parseHeading("Appendix", 15)).toEqual({ no: 15, title: "Appendix" });
  });

  it("splits long sections with one paragraph of overlap", () => {
    const para = (n: number) => `p${n} ` + "word ".repeat(100);
    const parts = splitBody([para(1), para(2), para(3), para(4)], 300);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[1][0]).toBe(parts[0][parts[0].length - 1]);
    expect(splitBody(["short"], 300)).toEqual([["short"]]);
  });
});
