import fs from "node:fs";
import path from "node:path";
import type { DocMeta, DocRecord } from "./types.js";

export interface ManifestResult {
  records: DocRecord[];
  warnings: string[];
}

function walkDocx(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDocx(full, out);
    else if (entry.name.toLowerCase().endsWith(".docx") && !entry.name.startsWith("~$")) out.push(full);
  }
  return out;
}

/** Read manifest.jsonl (the source of truth) and cross-check it against the files on disk. */
export function loadManifest(corpusDir: string): ManifestResult {
  const manifestPath = path.join(corpusDir, "manifest.jsonl");
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest.jsonl not found in ${corpusDir}`);

  const warnings: string[] = [];
  const records: DocRecord[] = [];
  const listed = new Set<string>();

  const lines = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let meta: DocMeta;
    try {
      meta = JSON.parse(line) as DocMeta;
    } catch {
      warnings.push(`manifest line ${i + 1}: invalid JSON, skipped`);
      return;
    }
    const absPath = path.resolve(corpusDir, meta.file_path);
    listed.add(absPath.toLowerCase());
    if (!fs.existsSync(absPath)) {
      warnings.push(`manifest line ${i + 1}: file missing on disk: ${meta.file_path}`);
      return;
    }
    records.push({ meta, absPath });
  });

  for (const file of walkDocx(corpusDir)) {
    if (!listed.has(path.resolve(file).toLowerCase())) {
      warnings.push(`file on disk not in manifest (skipped): ${path.relative(corpusDir, file)}`);
    }
  }
  return { records, warnings };
}
