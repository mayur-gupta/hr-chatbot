import crypto from "node:crypto";
import type { Block, Chunk, ChunkMetadata, DocMeta } from "./types.js";

/** Sections above this (estimated) token count get split on paragraph boundaries. */
export const MAX_SECTION_TOKENS = 400;
const COUNTRY_SPECIFIC_SECTION = 6;

export const estimateTokens = (text: string): number =>
  Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);

export const hashText = (text: string, embedModel: string): string =>
  crypto.createHash("sha256").update(`${embedModel}\n${text}`).digest("hex").slice(0, 32);

interface Section {
  no: number;
  title: string;
  body: string[];
}

/** "6. Country-Specific Provisions: United Kingdom" -> { no: 6, title: "Country-Specific Provisions: United Kingdom" } */
export function parseHeading(text: string, fallbackNo: number): { no: number; title: string } {
  const m = text.match(/^(\d+)\.\s*(.+)$/);
  return m ? { no: Number(m[1]), title: m[2].trim() } : { no: fallbackNo, title: text };
}

function groupSections(blocks: Block[]): Section[] {
  const sections: Section[] = [];
  for (const b of blocks) {
    if (b.type === "heading") {
      const { no, title } = parseHeading(b.text, sections.length + 1);
      sections.push({ no, title, body: [] });
    } else if (sections.length) {
      sections[sections.length - 1].body.push(b.text);
    }
  }
  return sections;
}

/** Split a long body on paragraph boundaries with one paragraph of overlap. */
export function splitBody(paras: string[], maxTokens = MAX_SECTION_TOKENS): string[][] {
  if (estimateTokens(paras.join("\n")) <= maxTokens || paras.length < 2) return [paras];
  const parts: string[][] = [];
  let current: string[] = [];
  for (const p of paras) {
    if (current.length && estimateTokens([...current, p].join("\n")) > maxTokens) {
      parts.push(current);
      current = [current[current.length - 1]]; // overlap
    }
    current.push(p);
  }
  if (current.length) parts.push(current);
  return parts;
}

export function contextHeader(meta: DocMeta, sectionNo: number, sectionTitle: string): string {
  const section = sectionNo === 0 ? "Document Summary" : `Section ${sectionNo}: ${sectionTitle}`;
  return (
    `Kalvora HR Policy | Country: ${meta.country} (${meta.country_code}) | ` +
    `Policy: ${meta.title} (${meta.doc_id})\n` +
    `Category: ${meta.category} | ${section}`
  );
}

function baseMetadata(meta: DocMeta, sourcePath: string, embedModel: string) {
  return {
    doc_id: meta.doc_id,
    title: meta.title,
    country: meta.country,
    country_code: meta.country_code,
    legal_entity: meta.legal_entity,
    category: meta.category,
    policy_number: Number(meta.policy_number),
    topic_code: meta.topic_code,
    version: String(meta.version),
    effective_date: meta.effective_date,
    last_reviewed: meta.last_reviewed,
    related_doc_ids: (meta.related_doc_ids ?? []).join(";"),
    source_path: sourcePath,
    embed_model: embedModel,
  };
}

function summaryText(meta: DocMeta, titles: Map<string, string>): string {
  const related = (meta.related_doc_ids ?? [])
    .map((id) => `- ${id}: ${titles.get(id) ?? "(unknown)"}`)
    .join("\n");
  return [
    `${meta.title} for ${meta.country}, issued by ${meta.legal_entity}.`,
    `Document ID: ${meta.doc_id} | Version: ${meta.version} | Category: ${meta.category} | Topic code: ${meta.topic_code}`,
    `Effective date: ${meta.effective_date} | Last reviewed: ${meta.last_reviewed} | Next review: ${meta.next_review} (${meta.review_cycle})`,
    `Policy owner: ${meta.policy_owner}`,
    `Approved by: ${meta.approved_by}`,
    related ? `Related policies:\n${related}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface ChunkOptions {
  embedModel: string;
  /** doc_id -> title, used to name related policies in the summary chunk. */
  titles: Map<string, string>;
}

export function chunkDocument(meta: DocMeta, blocks: Block[], sourcePath: string, opts: ChunkOptions): Chunk[] {
  const base = baseMetadata(meta, sourcePath, opts.embedModel);
  const chunks: Chunk[] = [];

  const push = (id: string, sectionNo: number, sectionTitle: string, body: string) => {
    const text = `${contextHeader(meta, sectionNo, sectionTitle)}\n\n${body}`;
    const metadata: ChunkMetadata = {
      ...base,
      section_no: sectionNo,
      section_title: sectionTitle,
      is_country_specific: sectionNo === COUNTRY_SPECIFIC_SECTION,
      content_hash: hashText(text, opts.embedModel),
    };
    chunks.push({ id, text, metadata });
  };

  push(`${meta.doc_id}::s00`, 0, "Document Summary", summaryText(meta, opts.titles));

  for (const section of groupSections(blocks)) {
    if (!section.body.length) continue;
    const sid = `${meta.doc_id}::s${String(section.no).padStart(2, "0")}`;
    const parts = splitBody(section.body);
    parts.forEach((paras, k) => {
      const id = parts.length > 1 ? `${sid}-p${k + 1}` : sid;
      push(id, section.no, section.title, paras.join("\n"));
    });
  }

  const ids = new Set<string>();
  for (const c of chunks) {
    if (ids.has(c.id)) throw new Error(`duplicate chunk id ${c.id}`);
    ids.add(c.id);
  }
  return chunks;
}
