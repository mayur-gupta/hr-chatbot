# Kalvora HR RAG: Ingestion Pipeline Plan (TypeScript)

## 1. Goal
Build an **ingestion pipeline** in TypeScript that turns the Kalvora HR policy corpus into a searchable vector index for a later RAG system. It parses, chunks, embeds and stores the documents, then runs a retrieval smoke test. Answer generation is out of scope for this phase.

- **Corpus:** `C:\Users\meetm\Downloads\Kalvora_HR_Policies_500\Kalvora_HR_Policies`
- **Embeddings:** LM Studio, running locally (OpenAI-compatible API)
- **Vector store:** ChromaDB, stored locally
- **Runtime:** Node 24 + TypeScript, run with `tsx`

---

## 2. What the corpus looks like

| Item | Detail |
|---|---|
| Documents | 500 `.docx` files: 50 policies × 10 countries (IN, US, GB, DE, NL, SG, AU, CA, AE, PH) |
| Metadata | `manifest.jsonl` / `index.csv`: doc_id, title, country, country_code, legal_entity, category, policy_number, topic_code, version, dates, owner, approver, related_doc_ids, word_count |
| Doc ID | `KAL-{CC}-HR-{NNN}`. The policy number means the same policy in every country (HR-016 is always Maternity Leave) |
| Length | 1,140–1,440 words per document |

**Inside each document:**
1. Banner + title + subtitle (entity and country)
2. Metadata table (the same data as the manifest)
3. **14 numbered `Heading 1` sections**: 1 Purpose · 2 Scope · 3 Definitions · 4 Policy Statement · 5 Process · **6 Country-Specific Provisions** · 7 Roles · 8 Exceptions · 9 Non-Compliance · 10 Communication · 11 Records · 12 Related Policies · 13 Contacts · 14 Review & Document Control
4. Revision-history table (Version · Date · Change · Approved By). Some rows record real legal changes, such as India's Labour Codes in 2025 and the UK Employment Rights Act 2025.

**The main RAG challenge:** the 10 country versions of a policy are **near-duplicates**. Only Section 6 (and some revision rows) differ much. Every chunk must therefore carry strong **country signals**, both in its embedded text and as filterable metadata.

---

## 3. Tech stack

| Concern | Package | Notes |
|---|---|---|
| DOCX → structure | `mammoth` + `node-html-parser` | mammoth converts to semantic HTML (`h1`, `p`, `ul/li`, `table`) using a style map (`Heading 1 → h1`, `List Paragraph → ul > li`). Walking the HTML keeps everything in document order. |
| Embeddings | `openai` (with `baseURL` set to LM Studio) | `POST http://localhost:1234/v1/embeddings` |
| Vector store | `chromadb` (JS client v3) | The JS client talks to a local Chroma server. The npm `chroma` CLI only supports ARM64 on Windows, so the server is the pinned Python `chromadb==1.5.9` in `.chroma-venv` (`npm run chroma:setup` once, then `npm run chroma`). `npm run chroma:docker` is an alternative. |
| CLI args | `commander` | |
| Config | `dotenv` + `zod` | Validated settings |
| Progress / logs | `cli-progress`, `pino` (or `console`) | |
| Dev | `typescript`, `tsx`, `@types/node`, `vitest` | `tsx` runs TS directly |

**Default embedding model:** `text-embedding-nomic-embed-text-v1.5`, loaded in LM Studio. It needs the task prefixes `search_document: ` and `search_query: `. Both the model and the prefixes are configurable in `.env`, so models like bge or gte also work.

---

## 4. Project layout

```
gen-ai-week-2/
├── PLAN.md
├── package.json            scripts: ingest, ingest:dry, chroma, smoke, test
├── tsconfig.json           ES2022, NodeNext, strict
├── .env / .env.example     CORPUS_DIR, LMSTUDIO_BASE_URL, EMBED_MODEL, DOC_PREFIX,
│                           QUERY_PREFIX, CHROMA_URL, COLLECTION, BATCH_SIZE
├── src/
│   ├── config.ts           load + validate env (zod) → Settings
│   ├── types.ts            DocMeta, Block, Chunk, ChunkMetadata
│   ├── manifest.ts         read manifest.jsonl, resolve paths, report mismatches
│   ├── parser.ts           parseDocx(path) → Block[] (heading | para | bullet | table)
│   ├── chunker.ts          Block[] + DocMeta → Chunk[] (section-aware + summary chunk)
│   ├── embedder.ts         LM Studio client: health check, batching, retry, prefixing
│   ├── store.ts            Chroma: get/create collection, hash diff, upsert, stale delete
│   ├── pipeline.ts         CLI entry (commander), orchestrates steps 1–7
│   └── smoke.ts            retrieval sanity checks
├── test/
│   ├── parser.test.ts      one real docx → 14 headings, revision table present
│   └── chunker.test.ts     IDs, headers, metadata scalars, split logic
└── data/                   chroma/ (DB files), chunks.jsonl (git-ignored)
```

---

## 5. Pipeline steps

### Step 1: Discover
- Load `manifest.jsonl` (UTF-8) as the **source of truth**, and resolve each `file_path` against `CORPUS_DIR`.
- Warn about manifest rows that have no file, and about `.docx` files on disk that the manifest does not list. Skip both.
- Filters: `--country GB`, `--limit N`.

### Step 2: Parse (`parser.ts`)
- Convert with mammoth using a style map:
  `p[style-name='Heading 1'] => h1:fresh`, `p[style-name='List Paragraph'] => ul > li:fresh`.
- Walk the top-level HTML nodes in order and emit `Block { type, text }`:
  - Drop everything **before the first `h1`** (banner, title, metadata table). That metadata comes from the manifest.
  - `h1` → `heading`; `li` → `bullet` (`- text`); `p` → `para`; `table` → `table`, rendered as markdown rows.
- Normalize text: decode HTML entities, collapse whitespace, replace non-breaking spaces.
- If no `h1` is found, throw. The pipeline logs the error and carries on with the next document.

### Step 3: Chunk (`chunker.ts`), section-aware
- **One chunk per `Heading 1` section**, 14 per document. Sections are roughly 80–150 words.
- The **revision-history table stays with Section 14** in one chunk.
- **Safeguard:** a section over ~400 tokens (estimated as words × 1.3) is split on paragraph boundaries, with a one-paragraph overlap.
- **Contextual header** prepended to every chunk's text, which is the key to separating near-duplicates:
  ```
  Kalvora HR Policy | Country: United Kingdom (GB) | Policy: Maternity Leave Policy (KAL-GB-HR-016)
  Category: Leave & Time Off | Section 6: Country-Specific Provisions: United Kingdom
  ```
- **Summary chunk per document** (`section_no = 0`): title, country, legal entity, category, version, effective/review dates, owner, approver, and related policy IDs **with their titles** (looked up from the manifest). It answers questions like "who owns the UK maternity policy?" or "when is it next reviewed?".
- **Deterministic IDs:** `{doc_id}::s{NN}` (for example `KAL-GB-HR-016::s06`). Split parts get a `-p{k}` suffix.
- **Expected total:** about 500 × 15 = **~7,500 chunks**.

### Step 4: Metadata per chunk
Chroma only accepts scalar values (string, number, boolean):

| Field | Type | Purpose |
|---|---|---|
| `doc_id`, `title`, `country`, `country_code`, `legal_entity`, `category`, `topic_code`, `version` | string | Filtering / citations |
| `policy_number`, `section_no` | number | Filtering (e.g. all HR-017 versions) |
| `section_title` | string | Display |
| `is_country_specific` | boolean | `true` for Section 6, used for country-focused retrieval |
| `effective_date`, `last_reviewed` | string (ISO) | Freshness |
| `related_doc_ids` | string (`;`-joined) | Multi-hop follow-ups |
| `source_path` | string | Link back to the file |
| `content_hash` | string | SHA-256 of embedded text + model, used to skip unchanged chunks |
| `embed_model` | string | Detects a model mismatch |

### Step 5: Embed (`embedder.ts`)
- `new OpenAI({ baseURL: LMSTUDIO_BASE_URL, apiKey: "lm-studio" })`.
- **Health check first:** `GET /v1/models`, then confirm `EMBED_MODEL` is loaded and embed a probe string to learn the vector **dimension**. If any of this fails, exit with a clear message: "Start the LM Studio server and load `<model>`".
- Send batches of `BATCH_SIZE` (default 64), with `DOC_PREFIX` prepended to each text. Retry with exponential backoff (3 attempts).
- Validate that every returned vector has the expected dimension.

### Step 6: Store (`store.ts`)
- `getOrCreateCollection(COLLECTION)` with cosine distance. The collection metadata stores `embed_model` and `embed_dim`.
  - If the collection already exists with a **different model or dimension**, refuse to run and tell the user to pass `--reset`.
- **Idempotent upserts:** fetch the existing `content_hash` for each chunk ID, then embed and upsert only chunks that are new or changed.
- **Stale cleanup:** for each document that is ingested, delete chunk IDs that exist for that `doc_id` but are no longer produced.
- `documents` holds the chunk text **without** the model prefix, so it is ready to show in citations later.
- `--reset` drops and recreates the collection.

### Step 7: Artifacts and reporting
- Write every chunk (ID, text, metadata) to `data/chunks.jsonl` for inspection and later evals.
- End-of-run summary: docs found / parsed / failed (with filenames), chunks new / updated / unchanged / deleted, collection count, and elapsed time.

### CLI
```bash
npm run chroma:setup                    # one time: install the Python Chroma server into .chroma-venv
npm run chroma                          # start local Chroma server on :8000 (data/chroma)
npm run ingest -- [--country GB] [--limit 5] [--reset]
npm run ingest:dry -- --country GB      # parse + chunk + chunks.jsonl only; no LM Studio/Chroma needed
npm run smoke                           # retrieval checks
```

---

## 6. Verification

1. **Setup:** run `npm install`. Start LM Studio's server and load the embedding model; `curl localhost:1234/v1/models` should list it. Run `npm run chroma`.
2. **Unit tests:** run `npm test`. The parser should find 14 headings and the revision table in a real UK document, and the chunker should produce correct IDs, headers and scalar-only metadata.
3. **Dry run:** run `npm run ingest:dry -- --country GB`. Expect **50 docs and ~750 chunks**. Spot-check `data/chunks.jsonl`: Section 6 text is complete, the revision table is rendered, and headers are correct.
4. **Idempotency:** run `npm run ingest -- --limit 5` twice. The second run should report every chunk as *unchanged*.
5. **Full run:** run `npm run ingest`. The collection count should equal the dry-run chunk count, with **500 distinct `doc_id`s** and **0 failures**.
6. **Smoke retrieval** (`npm run smoke`, top 5 with doc_id / section / distance):
   | Query | Expected |
   |---|---|
   | "How many weeks of paid partner leave do UK employees get?" | `KAL-GB-HR-017` section 6 in the top 3 |
   | The same query with `where: { country_code: "IN" }` | Only `KAL-IN-HR-017` chunks |
   | "Notice period for resignation in Germany" | `KAL-DE-HR-049` or `050` |
   | "India Labour Codes November 2025 change" | An IN section 14 (revision history) chunk |
   | Labeled set of ~10 country-specific questions | Report the **top-1 country accuracy** (a measure of how well near-duplicates are separated) |

---

## 7. Later work (not in this phase)
- Query-time country detection: extract the country from the question and apply a `where` filter automatically.
- Hybrid search (BM25 + vector) and a reranker.
- RAG answering with Claude, with citations to `doc_id` and section.
- An evaluation set built from the README's question types: country-specific facts, multi-hop questions, and global commitments.
