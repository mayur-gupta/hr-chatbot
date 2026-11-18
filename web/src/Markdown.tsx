/**
 * Minimal Markdown for model answers: paragraphs, bullet/numbered lists, headings,
 * **bold**, *italic*, `code`, and [KAL-XX-HR-000 §n] citations rendered as clickable chips.
 */
import { Fragment, type ReactNode } from "react";

interface Props {
  text: string;
  onCite: (label: string) => void;
  knownLabels: Set<string>;
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "h"; text: string }
  | { kind: "table"; rows: string[][] };

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    const isTableRow = /^\s*\|.*\|\s*$/.test(line);
    const last = blocks[blocks.length - 1];
    if (!line.trim()) {
      blocks.push({ kind: "p", lines: [] });
    } else if (isTableRow) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // header separator row
      if (last?.kind === "table") last.rows.push(splitRow(line));
      else blocks.push({ kind: "table", rows: [splitRow(line)] });
    } else if (heading) {
      blocks.push({ kind: "h", text: heading[1] });
    } else if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      const item = (bullet ?? numbered)![1];
      if (last?.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (last?.kind === "p") {
      last.lines.push(line);
    } else if ((last?.kind === "ul" || last?.kind === "ol") && /^\s{2,}/.test(raw)) {
      last.items[last.items.length - 1] += " " + line.trim(); // continuation of a list item
    } else {
      blocks.push({ kind: "p", lines: [line] });
    }
  }
  return blocks.filter((b) => b.kind !== "p" || b.lines.length);
}

const INLINE = /(\[[^\]\n]+\]|\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;

function inline(text: string, props: Props): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("[") && part.endsWith("]")) {
      // One bracket may hold several citations: [A §1; B §2]
      const labels = part.slice(1, -1).split(/\s*[;,]\s*(?=KAL-)/);
      if (labels.every((l) => /^KAL-/.test(l))) {
        return (
          <Fragment key={i}>
            {labels.map((l) => (
              <button key={l} className={`cite ${props.knownLabels.has(l) ? "" : "unknown"}`} onClick={() => props.onCite(l)} title="Show source">
                {l}
              </button>
            ))}
          </Fragment>
        );
      }
      return part;
    }
    if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("*") && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

export function Markdown(props: Props) {
  return (
    <>
      {parseBlocks(props.text).map((b, i) => {
        if (b.kind === "h") return <h3 key={i}>{inline(b.text, props)}</h3>;
        if (b.kind === "table") {
          const [head, ...body] = b.rows;
          return (
            <div key={i} className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {head.map((c, j) => (
                      <th key={j}>{inline(c, props)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
                        <td key={k}>{inline(c, props)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (b.kind === "p")
          return (
            <p key={i}>
              {b.lines.map((l, j) => (
                <Fragment key={j}>
                  {j > 0 && <br />}
                  {inline(l, props)}
                </Fragment>
              ))}
            </p>
          );
        const List = b.kind;
        return (
          <List key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it, props)}</li>
            ))}
          </List>
        );
      })}
    </>
  );
}
