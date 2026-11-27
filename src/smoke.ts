/** Retrieval sanity checks against the configured vector store (Chroma or the file index). */
import { loadSettings } from "./config.js";
import { Retriever } from "./retriever.js";

interface Case {
  query: string;
  /** Restrict the search to this country (like the UI's country filter). */
  filter?: string;
  /** Pass if one of the top `within` results has one of these doc ids (and section, if given). */
  expectDocs: string[];
  expectSection?: number;
  within: number;
  /** Country the top-1 result should come from (for the country-accuracy score). */
  country?: string;
}

const CASES: Case[] = [
  { query: "How many weeks of paid partner leave do UK employees get?", expectDocs: ["KAL-GB-HR-017"], expectSection: 6, within: 3, country: "GB" },
  { query: "How many weeks of paid partner leave do employees get?", filter: "IN", expectDocs: ["KAL-IN-HR-017"], within: 5, country: "IN" },
  { query: "What is the notice period for resignation in Germany?", expectDocs: ["KAL-DE-HR-049", "KAL-DE-HR-050"], within: 5, country: "DE" },
  { query: "India Labour Codes November 2025 change", expectDocs: [], expectSection: 14, within: 5, country: "IN" },
  { query: "How much maternity leave do employees in Singapore get?", expectDocs: ["KAL-SG-HR-016"], within: 3, country: "SG" },
  { query: "Overtime pay rate for employees in the Philippines", expectDocs: ["KAL-PH-HR-008"], within: 3, country: "PH" },
  { query: "Annual leave entitlement in the Netherlands", expectDocs: [], within: 5, country: "NL" },
  { query: "Probation period length in the United Arab Emirates", expectDocs: ["KAL-AE-HR-004"], within: 3, country: "AE" },
  { query: "Sick leave rules for employees in Australia", expectDocs: [], within: 5, country: "AU" },
  { query: "Who owns the Canada maternity leave policy?", expectDocs: ["KAL-CA-HR-016"], within: 3, country: "CA" },
  { query: "Overtime rules for employees in Texas and New Jersey", expectDocs: ["KAL-US-HR-008"], within: 5, country: "US" },
];

async function main(): Promise<void> {
  const settings = loadSettings();
  const retriever = await Retriever.open(settings);
  console.log(`${retriever.store.label}: ${await retriever.store.count()} chunks
`);

  let passed = 0;
  let countryHits = 0;
  let countryTotal = 0;

  for (const c of CASES) {
    const hits = await retriever.retrieve(c.query, 5, c.filter ? [c.filter] : []);
    const rows = hits.map((h) => ({ doc: h.docId, section: h.sectionNo, cc: h.countryCode, dist: h.distance }));

    const top = rows.slice(0, c.within);
    const ok = top.some(
      (r) =>
        (c.expectDocs.length === 0 || c.expectDocs.includes(r.doc)) &&
        (c.expectSection === undefined || r.section === c.expectSection) &&
        (c.country === undefined || r.cc === c.country),
    );
    if (ok) passed++;
    if (c.country) {
      countryTotal++;
      if (rows[0]?.cc === c.country) countryHits++;
    }

    console.log(`${ok ? "PASS" : "FAIL"}  ${c.query}${c.filter ? `  filter=${c.filter}` : ""}`);
    for (const r of rows) console.log(`        ${r.doc}  s${String(r.section).padStart(2, "0")}  d=${r.dist.toFixed(4)}`);
  }

  console.log(`\nChecks passed: ${passed}/${CASES.length}`);
  console.log(`Top-1 country accuracy: ${countryHits}/${countryTotal} (${((100 * countryHits) / countryTotal).toFixed(0)}%)`);
  if (passed < CASES.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nERROR: ${(err as Error).message}`);
  process.exit(1);
});
