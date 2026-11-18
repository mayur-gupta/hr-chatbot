/** One row of manifest.jsonl. */
export interface DocMeta {
  doc_id: string;
  file_path: string;
  title: string;
  country: string;
  country_code: string;
  legal_entity: string;
  category: string;
  policy_number: number;
  topic_code: string;
  version: string;
  effective_date: string;
  last_reviewed: string;
  next_review: string;
  review_cycle: string;
  policy_owner: string;
  approved_by: string;
  related_doc_ids: string[];
  word_count: number;
}

export interface DocRecord {
  meta: DocMeta;
  absPath: string;
}

export type BlockType = "heading" | "para" | "bullet" | "table";

export interface Block {
  type: BlockType;
  text: string;
}

/** Chroma metadata accepts only scalar values. */
export interface ChunkMetadata {
  [key: string]: string | number | boolean;
  doc_id: string;
  title: string;
  country: string;
  country_code: string;
  legal_entity: string;
  category: string;
  policy_number: number;
  topic_code: string;
  version: string;
  effective_date: string;
  last_reviewed: string;
  section_no: number;
  section_title: string;
  is_country_specific: boolean;
  related_doc_ids: string;
  source_path: string;
  content_hash: string;
  embed_model: string;
}

export interface Chunk {
  id: string;
  /** Text that gets embedded and stored (header + body, no model prefix). */
  text: string;
  metadata: ChunkMetadata;
}
