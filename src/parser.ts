import fs from "node:fs/promises";
import JSZip from "jszip";
import mammoth from "mammoth";
import { parse, HTMLElement, NodeType } from "node-html-parser";
import type { Block } from "./types.js";

const STYLE_MAP = [
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='List Paragraph'] => ul > li:fresh",
];

/** Collapse whitespace; node-html-parser's .text already decodes entities. */
export function clean(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function tableToMarkdown(table: HTMLElement): string {
  const rows = table
    .querySelectorAll("tr")
    .map((tr) => tr.querySelectorAll("th, td").map((c) => clean(c.text).replace(/\|/g, "/")))
    .filter((cells) => cells.some(Boolean));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

/** Turn mammoth HTML into ordered blocks. Everything before the first <h1>
 *  (banner, title, metadata table) is dropped here; htmlToHeader reads it for metadata. */
export function htmlToBlocks(html: string): Block[] {
  const root = parse(html);
  const blocks: Block[] = [];
  let started = false;

  for (const node of root.childNodes) {
    if (node.nodeType !== NodeType.ELEMENT_NODE) continue;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === "h1") {
      started = true;
      const text = clean(el.text);
      if (text) blocks.push({ type: "heading", text });
      continue;
    }
    if (!started) continue;

    switch (tag) {
      case "ul":
      case "ol":
        for (const li of el.querySelectorAll("li")) {
          const text = clean(li.text);
          if (text) blocks.push({ type: "bullet", text: `- ${text}` });
        }
        break;
      case "table": {
        const md = tableToMarkdown(el);
        if (md) blocks.push({ type: "table", text: md });
        break;
      }
      case "h2":
      case "h3": {
        const text = clean(el.text);
        if (text) blocks.push({ type: "para", text: `**${text}**` });
        break;
      }
      default: {
        const text = clean(el.text);
        if (text) blocks.push({ type: "para", text });
      }
    }
  }

  if (!blocks.some((b) => b.type === "heading")) throw new Error("no Heading 1 sections found");
  return blocks;
}

/** "Legal Entity" -> "legal_entity" */
export const normalizeLabel = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Read the label/value metadata table(s) that sit before the first <h1>.
 *  Rows are read as alternating label, value cells: | Document ID | KAL-.. | Version | 2.1 | */
export function htmlToHeader(html: string): Record<string, string> {
  const root = parse(html);
  const header: Record<string, string> = {};
  for (const node of root.childNodes) {
    if (node.nodeType !== NodeType.ELEMENT_NODE) continue;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "h1") break;
    if (tag !== "table") continue;
    for (const tr of el.querySelectorAll("tr")) {
      const cells = tr.querySelectorAll("th, td").map((c) => clean(c.text));
      for (let i = 0; i + 1 < cells.length; i += 2) {
        const key = normalizeLabel(cells[i]);
        if (key && cells[i + 1] && !(key in header)) header[key] = cells[i + 1];
      }
    }
  }
  return header;
}

/** Core document properties (docProps/core.xml): title, subject, keywords, description. */
export interface DocProperties {
  title?: string;
  subject?: string;
  keywords?: string;
  description?: string;
}

async function readCoreProperties(buffer: Buffer): Promise<DocProperties> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("docProps/core.xml")?.async("string");
    if (!xml) return {};
    const root = parse(xml);
    const get = (tag: string) => {
      const text = root.querySelector(tag.replace(":", "\\:"))?.text;
      return text ? clean(text) : undefined;
    };
    return { title: get("dc:title"), subject: get("dc:subject"), keywords: get("cp:keywords"), description: get("dc:description") };
  } catch {
    return {}; // properties are optional; the header table is the main source
  }
}

export interface ParsedDocument {
  blocks: Block[];
  header: Record<string, string>;
  properties: DocProperties;
}

export async function parseDocument(absPath: string): Promise<ParsedDocument> {
  const buffer = await fs.readFile(absPath);
  const [{ value }, properties] = await Promise.all([
    mammoth.convertToHtml({ buffer }, { styleMap: STYLE_MAP }),
    readCoreProperties(buffer),
  ]);
  return { blocks: htmlToBlocks(value), header: htmlToHeader(value), properties };
}

export async function parseDocx(absPath: string): Promise<Block[]> {
  return (await parseDocument(absPath)).blocks;
}
