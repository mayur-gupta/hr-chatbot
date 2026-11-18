/** Query side of the RAG: detect countries, embed the question, search Chroma. */
import type { Collection, Where } from "chromadb";
import type { Settings } from "./config.js";
import { Embedder } from "./embedder.js";
import { chromaClient, ensureChromaUp } from "./store.js";

export interface Hit {
  id: string;
  text: string;
  docId: string;
  title: string;
  country: string;
  countryCode: string;
  sectionNo: number;
  sectionTitle: string;
  distance: number;
}

/** Country names/adjectives (case-insensitive) and acronyms (case-sensitive, so "us"/"in" don't match). */
const COUNTRIES: { code: string; names: string[]; acronyms: string[] }[] = [
  { code: "IN", names: ["india", "indian"], acronyms: [] },
  { code: "US", names: ["united states", "america", "american"], acronyms: ["US", "U.S.", "USA", "U.S.A."] },
  { code: "GB", names: ["united kingdom", "britain", "british", "england", "english", "scotland", "wales"], acronyms: ["UK", "U.K.", "GB"] },
  { code: "DE", names: ["germany", "german"], acronyms: [] },
  { code: "NL", names: ["netherlands", "dutch", "holland"], acronyms: [] },
  { code: "SG", names: ["singapore", "singaporean"], acronyms: [] },
  { code: "AU", names: ["australia", "australian"], acronyms: [] },
  { code: "CA", names: ["canada", "canadian"], acronyms: [] },
  { code: "AE", names: ["united arab emirates", "emirates", "emirati", "dubai", "abu dhabi"], acronyms: ["UAE", "U.A.E."] },
  { code: "PH", names: ["philippines", "philippine", "filipino"], acronyms: [] },
];

export const COUNTRY_CODES = COUNTRIES.map((c) => c.code);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Country codes mentioned in the text, in order of first mention. */
export function detectCountries(text: string): string[] {
  const found: { code: string; at: number }[] = [];
  for (const c of COUNTRIES) {
    const patterns = [
      ...c.names.map((n) => new RegExp(`\\b${esc(n)}\\b`, "i")),
      ...c.acronyms.map((a) => new RegExp(`(?<![A-Za-z])${esc(a)}(?![A-Za-z])`)),
    ];
    const positions = patterns.map((p) => text.search(p)).filter((i) => i >= 0);
    if (positions.length) found.push({ code: c.code, at: Math.min(...positions) });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.code);
}

export class Retriever {
  private constructor(
    private embedder: Embedder,
    private col: Collection,
  ) {}

  static async open(settings: Settings): Promise<Retriever> {
    const embedder = new Embedder(settings);
    await embedder.healthCheck();
    const client = chromaClient(settings);
    await ensureChromaUp(client, settings);
    let col: Collection;
    try {
      col = await client.getCollection({ name: settings.collection });
    } catch {
      throw new Error(`Collection "${settings.collection}" not found. Run the ingestion first: npm run ingest`);
    }
    return new Retriever(embedder, col);
  }

  /**
   * Top-k chunks for a query. With several countries, k is split across them so each one
   * is represented (needed for "compare X vs Y" questions). Falls back to an unfiltered
   * search if the filtered one comes back empty.
   */
  async retrieve(query: string, k: number, countries: string[] = []): Promise<Hit[]> {
    const [vector] = await this.embedder.embedQueries([query]);
    if (!countries.length) return this.search(vector, k);

    const perCountry = Math.max(2, Math.ceil(k / countries.length));
    const groups = await Promise.all(countries.map((cc) => this.search(vector, perCountry, { country_code: cc })));
    const hits = groups.flat().sort((a, b) => a.distance - b.distance);
    return hits.length ? hits : this.search(vector, k);
  }

  private async search(vector: number[], k: number, where?: Where): Promise<Hit[]> {
    const res = await this.col.query({
      queryEmbeddings: [vector],
      nResults: k,
      where,
      include: ["documents", "metadatas", "distances"],
    });
    return res.ids[0].map((id, j) => {
      const m = res.metadatas[0][j] ?? {};
      return {
        id,
        text: res.documents[0][j] ?? "",
        docId: String(m.doc_id),
        title: String(m.title),
        country: String(m.country),
        countryCode: String(m.country_code),
        sectionNo: Number(m.section_no),
        sectionTitle: String(m.section_title),
        distance: res.distances[0][j] ?? NaN,
      };
    });
  }
}
