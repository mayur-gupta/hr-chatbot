import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { parseDocx, htmlToBlocks } from "../src/parser.js";

const settings = loadSettings();
const sample = path.join(settings.corpusDir, "United Kingdom", "KAL-GB-HR-016 Maternity Leave Policy (United Kingdom).docx");

describe("htmlToBlocks", () => {
  it("drops everything before the first h1 and renders tables", () => {
    const blocks = htmlToBlocks(
      "<p>BANNER</p><table><tr><td>meta</td></tr></table><h1>1. Purpose</h1><p>Body &amp; more</p>" +
        "<ul><li>one</li></ul><table><tr><th>V</th><th>Date</th></tr><tr><td>1.0</td><td>2020</td></tr></table>",
    );
    expect(blocks.map((b) => b.type)).toEqual(["heading", "para", "bullet", "table"]);
    expect(blocks[1].text).toBe("Body & more");
    expect(blocks[3].text).toBe("| V | Date |\n| --- | --- |\n| 1.0 | 2020 |");
  });

  it("throws when there are no sections", () => {
    expect(() => htmlToBlocks("<p>nothing</p>")).toThrow();
  });
});

describe.skipIf(!fs.existsSync(sample))("parseDocx (real UK maternity policy)", () => {
  it("finds 14 sections, Section 6 text and the revision table", async () => {
    const blocks = await parseDocx(sample);
    const headings = blocks.filter((b) => b.type === "heading").map((b) => b.text);
    expect(headings).toHaveLength(14);
    expect(headings[5]).toBe("6. Country-Specific Provisions: United Kingdom");
    expect(blocks.some((b) => b.text.includes("52 weeks"))).toBe(true);
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe("table");
    expect(last.text).toContain("| Version | Date | Description of Change | Approved By |");
    expect(blocks.some((b) => b.text.includes("KAL-GB-HR-016") && b.type !== "bullet")).toBe(false); // metadata table dropped
  });
});
