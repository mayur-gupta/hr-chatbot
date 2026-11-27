/** Query side of the RAG: detect countries, embed the question, search the vector store. */
import type { Settings } from "./config.js";
import { Embedder } from "./embedder.js";
import type { Hit } from "./types.js";
import { openSearchStore, type SearchStore } from "./vectorStore.js";

export type { Hit } from "./types.js";

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
    readonly store: SearchStore,
  ) {}

  static async open(settings: Settings): Promise<Retriever> {
    const store = await openSearchStore(settings);
    const embedder = new Embedder(settings);
    // Queries must use the prefix the stored vectors were built for, whatever QUERY_PREFIX says.
    if (store.queryPrefix !== undefined) embedder.queryPrefix = store.queryPrefix;
    if (store.dim) {
      // Supabase / file index: the dimension is known, so skip the probe request. On a serverless
      // cold start that saves a round trip and a request against free-tier rate limits.
      embedder.dimension = store.dim;
    } else {
      await embedder.healthCheck();
    }
    return new Retriever(embedder, store);
  }

  /**
   * Top-k chunks for a query. With several countries, k is split across them so each one
   * is represented (needed for "compare X vs Y" questions). Falls back to an unfiltered
   * search if the filtered one comes back empty.
   */
  async retrieve(query: string, k: number, countries: string[] = []): Promise<Hit[]> {
    const [vector] = await this.embedder.embedQueries([query]);
    if (!countries.length) return this.store.search(vector, k);

    const perCountry = Math.max(2, Math.ceil(k / countries.length));
    const groups = await Promise.all(countries.map((cc) => this.store.search(vector, perCountry, cc)));
    const hits = groups.flat().sort((a, b) => a.distance - b.distance);
    return hits.length ? hits : this.store.search(vector, k);
  }
}
