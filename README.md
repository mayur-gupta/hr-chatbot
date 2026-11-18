# Kalvora HR Policies: RAG Ingestion

TypeScript pipeline that parses the 500 Kalvora HR policy `.docx` files, splits them into section-level chunks, embeds them with **LM Studio**, and stores them in **ChromaDB**. The design is described in [PLAN.md](PLAN.md).

## Quick start

```bash
npm install
npm run chroma:setup        # one time: installs the Chroma server (Python) into .chroma-venv
```

Then, each session:

1. **LM Studio:** load an embedding model (default `text-embedding-nomic-embed-text-v1.5`) and start the server (Developer tab, then *Start Server*, port 1234).
2. **Chroma:** in a separate terminal, run `npm run chroma` (serves on `localhost:8000`, data in `./data/chroma`).
3. **Ingest:**
   ```bash
   npm run ingest              # all 500 docs (~7,500 chunks); re-runs only embed changed chunks
   npm run smoke               # retrieval sanity checks + top-1 country accuracy
   ```

Settings live in `.env` (copied from `.env.example`). If you use a model without task prefixes (bge, gte, MiniLM), set `DOC_PREFIX=""` and `QUERY_PREFIX=""`.

## Commands

| Command | What it does |
|---|---|
| `npm run ingest:dry` | Parse + chunk + write `data/chunks.jsonl`. Needs neither LM Studio nor Chroma |
| `npm run ingest -- --country GB` | Ingest one country only (`--limit N` also works) |
| `npm run ingest -- --reset` | Drop and rebuild the collection (required after changing `EMBED_MODEL`) |
| `npm run smoke` | Run the labelled retrieval checks |
| `npm test` / `npm run typecheck` | Unit tests / type check |
| `npm run chroma:docker` | Alternative to `npm run chroma` if Docker Desktop is running |
| `npm run ask` | Terminal chat over the policies (`npm run ask -- "question"` for one-shot) |
| `npm run server` | Chat API on http://localhost:3001 (also serves the built UI) |
| `npm run web` | React chat UI dev server on http://localhost:5173 (proxies `/api` to the server) |
| `npm run build:web` | Build the UI into `web/dist`, served by `npm run server` |

## Chat UI

Start Chroma and LM Studio, then run `npm run server` and `npm run web` in two terminals and open http://localhost:5173. The UI streams answers, shows each citation as a chip that opens its source excerpt, lets you pin the search to specific countries, and keeps short follow-ups ("and in Germany?") in context. Conversation state lives in the browser, so the server is stateless.

## What gets stored

- **15 chunks per document:** one per numbered section (1–14), plus a metadata summary chunk (`::s00`). The revision-history table stays with Section 14.
- Each chunk starts with a header such as `Country: United Kingdom (GB) | Policy: Maternity Leave Policy (KAL-GB-HR-016) | Section 6: …`, so near-identical country versions stay apart.
- **Filterable metadata:** `doc_id`, `country_code`, `policy_number`, `section_no`, `is_country_specific` (Section 6), `category`, dates, `related_doc_ids`, and more. Example filter: `where: { $and: [{ country_code: "IN" }, { is_country_specific: true }] }`.
- Chunk IDs are deterministic (`KAL-GB-HR-016::s06`), and a content hash makes re-runs incremental.

## Layout

```
src/config.ts     env settings (zod)        src/embedder.ts  LM Studio client
src/manifest.ts   manifest.jsonl loader     src/store.ts     Chroma helpers
src/parser.ts     docx → blocks (mammoth)   src/pipeline.ts  CLI
src/chunker.ts    section chunks + header   src/smoke.ts     retrieval checks
src/retriever.ts  query + country filter    src/answer.ts    grounded answer (LM Studio)
src/chat.ts       follow-up/country logic   src/ask.ts       terminal chat
src/server.ts     HTTP API (NDJSON stream)  web/             React + Vite chat UI
scripts/          Chroma server launcher / setup
```
