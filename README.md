# Kalvora HR Policies: RAG Ingestion

TypeScript RAG app over the 500 Kalvora HR policy `.docx` files. It splits them into section-level chunks, embeds them, and stores them in **ChromaDB** (local), **Supabase pgvector** (deployed) or a **file index** (no database). A React chat UI with Google sign-in sits on top. Models come from **LM Studio** locally or any OpenAI-compatible provider, such as the free Gemini API tier. The design is in [PLAN.md](PLAN.md), and deployment is in [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md).

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

Settings live in `.env` (copied from `.env.example`). If you use a model without task prefixes (bge, gte, MiniLM), set `DOC_PREFIX=""` and `QUERY_PREFIX=""`. The policy files are in [corpus/](corpus) (the default `CORPUS_DIR`).

## Commands

| Command | What it does |
|---|---|
| `npm run ingest:dry` | Parse + chunk + write `data/chunks.jsonl`. Needs neither LM Studio nor Chroma |
| `npm run ingest -- --country GB` | Ingest one country only (`--limit N` also works) |
| `npm run ingest -- --reset` | Drop and rebuild the collection (required after changing `EMBED_MODEL`) |
| `npm run ingest -- --prune` | Also delete chunks of policies removed from the corpus (what each production deploy runs) |
| `npm run ingest -- --max-embed 950` | Embed at most 950 chunks this run and leave the rest for the next (Gemini free tier: 1,000 embeddings a day) |
| `npm run smoke` | Run the labelled retrieval checks |
| `npm test` / `npm run typecheck` | Unit tests / type check |
| `npm run chroma:docker` | Alternative to `npm run chroma` if Docker Desktop is running |
| `npm run ask` | Terminal chat over the policies (`npm run ask -- "question"` for one-shot) |
| `npm run server` | Chat API on http://localhost:3001 (also serves the built UI) |
| `npm run web` | React chat UI dev server on http://localhost:5173 (proxies `/api` to the server) |
| `npm run build:web` | Build the UI into `web/dist`, served by `npm run server` |
| `npm run models` | List the model ids the configured chat/embedding endpoints offer |
| `VECTOR_STORE=file npm run ingest -- --reset` | Build the file index in `data/index` instead of Chroma (incremental re-runs work too) |
| `npm run export-index` | Copy the Chroma collection into `data/index` without re-embedding |
| `npm run build:vercel` | Build `.vercel/output` (UI + bundled API function) for `vercel deploy --prebuilt` |

## Chat UI

Start Chroma and LM Studio, then run `npm run server` and `npm run web` in two terminals and open http://localhost:5173. The UI streams answers, shows each citation as a chip that opens its source excerpt, lets you pin the search to specific countries, and keeps short follow-ups ("and in Germany?") in context. Conversation state lives in the browser, so the server is stateless.

### Google sign-in

The UI and every `/api` route except `/api/auth/*` require a Google account once `GOOGLE_CLIENT_ID` is set. Without it, sign-in is off and the server prints a warning (fine on localhost, refused on Vercel / `NODE_ENV=production`).

1. In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application** (set up the OAuth consent screen first if asked).
2. Under **Authorized JavaScript origins** add `http://localhost`, `http://localhost:5173`, `http://localhost:3001`, and later your production URL. No redirect URIs are needed (popup flow).
3. In `.env` set `GOOGLE_CLIENT_ID`, and `SESSION_SECRET` to 32+ random characters (`openssl rand -hex 32`).
4. Optionally restrict who can sign in with `ALLOWED_DOMAINS=kalvora.com` and/or `ALLOWED_EMAILS=a@x.com,b@y.com`.

How it works: Google Identity Services gives the browser an ID token, `POST /api/auth/google` verifies it (signature, audience, verified email, allowlist), and the server sets its own HMAC-signed `HttpOnly; SameSite=Lax` session cookie (7 days by default). No session store is needed.

## Free hosted setup

The deployed app needs no paid services:

| Piece | Service |
|---|---|
| Hosting | Vercel Hobby (free, non-commercial use only), function in `bom1` (Mumbai) |
| Chat + embeddings | Gemini API free tier, through its OpenAI-compatible endpoint |
| Vectors | Supabase free tier: Postgres + pgvector (`kalvora-hr`, ap-south-1). HNSW cosine index, country filter in SQL, server-only access. Schema in [supabase/migrations](supabase/migrations) |
| CI/CD | GitHub Actions ([.github/workflows](.github/workflows)) |

To switch, set the Gemini variables shown in `.env.example`, plus `VECTOR_STORE=supabase`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (the `sb_secret_…` key). Then load the vectors and check them with `npm run smoke`. The Gemini free tier embeds only 1,000 chunks a day, so the first load of 7,500 takes about 8 daily runs of `npm run ingest -- --prune --max-embed 950` (see DEPLOYMENT_PLAN §9). The query embeddings must come from the same model as the stored vectors, so vectors built with local nomic embeddings won't work with Gemini. The table is `vector(768)`, so keep `EMBED_DIMENSIONS=768`.

Every production deploy then keeps the vectors in sync with `corpus/`: before shipping the code, the pipeline runs `npm run ingest -- --prune` and `npm run smoke`. Unchanged chunks are skipped by content hash, so a deploy without policy changes makes no embedding calls. To change policies, edit `corpus/` (and its `manifest.jsonl`) in a PR and merge it. Previews read the production vectors and never write them. Free Supabase projects pause after a week without use; the twice-weekly `retrieval-smoke` workflow keeps the project active, and a paused project can be restored from the dashboard.

`VECTOR_STORE=file` still works: it searches `data/index/` in memory with no database. To deploy that way, build with `BUNDLE_INDEX=1 npm run build:vercel` and set `VECTOR_STORE=file` on Vercel. Free-tier prompts may be used by Google to improve its products, which is fine for this fictional corpus but not for real employee data. The full rollout is in [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md).

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
src/app.ts        HTTP API handler          src/server.ts    local server (API + built UI)
src/auth.ts       Google sign-in + session  src/fileIndex.ts in-memory vector index (int8)
src/vectorStore.ts  Supabase, Chroma or file index
src/supabaseStore.ts  Supabase pgvector     web/             React + Vite chat UI
scripts/          Chroma launcher, build-vercel.mjs, smoke-deploy.mjs
supabase/migrations/  pgvector schema + search function
corpus/           the 500 policy .docx files + manifest.jsonl (synthetic)
data/index/       file vector index (VECTOR_STORE=file)
```
