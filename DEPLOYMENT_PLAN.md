# Deployment Plan: Kalvora HR Assistant on Vercel (free tier) with GitHub Actions CI/CD

| | |
|---|---|
| **Repo** | `mayur-gupta/hr-chatbot` (`main`) |
| **Status** | Code done and tested locally. Accounts, keys and the first deploy still to do (§10) |
| **Date** | 2026-11-19 (vector store moved to Supabase pgvector on 2026-11-25) |
| **Scope** | Run the RAG chat app (React UI, chat API, Google sign-in) on Vercel for **$0/month**, with a GitHub Actions pipeline that tests, previews and ships every change |
| **Use** | Personal, learning or portfolio project. See D4 before any commercial or real-employee use |

---

## 1. Summary

The app ran only on a developer PC: LM Studio for models and a local Chroma server for vectors. The free deployment changes three things:

1. **Models: the Gemini API free tier, through its OpenAI-compatible endpoint.** The code already used the OpenAI SDK, so the change is configuration plus a re-embed of the corpus.
2. **Vectors: Supabase Postgres + pgvector (free tier).** The 7,500 chunk vectors live in the `kalvora-hr` project (ap-south-1, Mumbai), in a `vector(768)` column with an HNSW cosine index. One SQL function does top-k search with the country filter.
3. **Hosting: Vercel Hobby, built by GitHub Actions.** CI bundles the API into one Node function (Vercel Build Output API), pinned to `bom1` next to the database, and deploys it with the UI.

Running cost: **$0/month.** The trade-offs are rate limits, non-commercial use only, and data-use terms. They are covered in §3, §11 and §13.

---

## 2. Current state

| Area | Status |
|---|---|
| UI | React 19 + Vite in `web/`. Streams answers, citation chips, country filter |
| API | [src/app.ts](src/app.ts): a plain Node `(req, res)` handler. Used by [src/server.ts](src/server.ts) locally and bundled as the Vercel function |
| Auth | Google sign-in ([src/auth.ts](src/auth.ts)): verifies the Google ID token, issues an HMAC-signed `HttpOnly` cookie. Stateless |
| Models | Any OpenAI-compatible endpoint (`CHAT_*`, `EMBED_*`), falling back to LM Studio (`LMSTUDIO_*`). `npm run models` lists the ids |
| Vectors | `VECTOR_STORE=supabase` ([src/supabaseStore.ts](src/supabaseStore.ts), the default on Vercel), `chroma` (local server) or `file` ([src/fileIndex.ts](src/fileIndex.ts), no database) |
| Database | Supabase project `kalvora-hr` (ref `txkivrtpuiqphwvdanei`, ap-south-1). Schema applied: [supabase/migrations](supabase/migrations). Tables are empty until §9 |
| Deploy build | `npm run build:vercel` → `.vercel/output` (static UI + bundled function in `bom1`; the index is bundled only with `BUNDLE_INDEX=1`) |
| CI/CD | [.github/workflows/pipeline.yml](.github/workflows/pipeline.yml), [retrieval-smoke.yml](.github/workflows/retrieval-smoke.yml), [dependabot.yml](.github/dependabot.yml), [scripts/smoke-deploy.mjs](scripts/smoke-deploy.mjs) |
| Tests | 41 Vitest tests (parser, chunker, auth, config, file index, Supabase store mapping, local file-index structure when present) + `npm run smoke` retrieval checks |

**Verified locally:**
- The file index gives the same smoke results as Chroma on the real corpus: 11/11 checks, 100% top-1 country accuracy. Distances agree to about 0.0005, and the only ranking differences are near-ties.
- The built function bundle, loaded from another directory with `VERCEL=1`, passes the deploy smoke checks for auth and backend readiness. It answered the UK partner-leave question with a `[KAL-GB-HR-017 §6]` citation. The local model was too slow for the 30 s limit; that limit is meant for a hosted model.

- The Supabase search function, run as `service_role` on test rows: exact match at distance 0, and the country filter returns only that country. `anon` has no access to the tables or the function.

**Not yet done:** the Supabase tables are empty. Ingest the corpus with Gemini embeddings into Supabase (§9) before deploying.

---

## 3. Decisions

| # | Decision | Choice | Alternatives | Why |
|---|---|---|---|---|
| D1 | Chat LLM | **Gemini API free tier**, a Flash-class model (pick the id with `npm run models`) | Groq free tier (also OpenAI-compatible); OpenRouter free models | Free, fast, OpenAI-compatible: only `.env` changes. Same key as D2 |
| D2 | Embeddings | **`gemini-embedding-001` at 768 dimensions**, no task prefixes | Keep local nomic (no free host) | Free on the same key. Requires a one-time re-embed of the corpus (~118 batches of 64 chunks) |
| D3 | Vector store | **Supabase pgvector, free tier** (`kalvora-hr`, ap-south-1). HNSW cosine index; `match_kalvora_chunks()` does top-k with an optional country filter (iterative scan, so filtered searches still return k rows). RLS on with no policies; only the server's secret key can read | File index in the repo (still available as `VECTOR_STORE=file`); Chroma Cloud (credits, then paid) | A real database for $0. Float vectors (~23 MB), text and the HNSW index come to well under 100 MB of the 500 MB free tier. Re-ingesting no longer means committing 13 MB, and the function bundle drops from ~17 MB to 3.5 MB. Cost: one network hop per query (kept short by `bom1`), and free projects pause after a week without use (§13) |
| D4 | Vercel plan | **Hobby** | Pro (~$20/month) | Free. **Hobby is for non-commercial use only.** Use by a real company means Pro (and D1 moves to a paid, no-training tier) |
| D5 | Who can sign in | **`ALLOWED_EMAILS=<your accounts>`** (or `ALLOWED_DOMAINS`) | Any Google account | Otherwise anyone with a Google account can use up the free model quota |
| D6 | Production approval | **Required reviewer on the GitHub `production` environment**, if available | Auto-deploy on merge | Free on public repos. Private repos on GitHub Free don't get environment reviewers; there, branch protection (PR + passing CI) is the gate |
| D7 | Ingestion | **Manual, from a developer machine** (§9), writing straight to Supabase | CI job pulling the corpus from storage | The corpus changes rarely and isn't in the repo |

---

## 4. Requirements

### 4.1 Functional

| ID | Requirement |
|---|---|
| FR-1 | Signed-in users ask questions in the web UI and get streamed answers grounded in the policies, with clickable `[KAL-XX-HR-NNN §n]` citations |
| FR-2 | Country detection, the country filter and short follow-ups ("and in Germany?") behave as they do locally |
| FR-3 | Only allowlisted Google accounts (D5) can use the UI or any `/api` route other than `/api/auth/*` |
| FR-4 | Users can sign out. Sessions expire after `SESSION_TTL_HOURS`. Removing someone from the allowlist ends their sessions immediately |
| FR-5 | Stop / closing the tab aborts generation upstream |
| FR-6 | Every PR gets a preview deployment, and its URL is posted on the PR |
| FR-7 | Merging to `main` deploys to production once CI passes (and the approval, if D6 is available) |
| FR-8 | A production deploy that fails its smoke test is rolled back automatically |
| FR-9 | When the free-tier rate limit is hit, users see "rate limit reached, wait a minute", not a raw error. Implemented in `friendlyError` |

### 4.2 Non-functional

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Time to first token | p50 < 3 s, p95 < 8 s (Flash model) |
| NFR-2 | Full answer | p95 < 30 s. Function `maxDuration` 120 s (Hobby allows up to 300 s) |
| NFR-3 | Cold start | < 2 s extra: loading the 13 MB index is local file I/O, and no model probe calls are made at start-up |
| NFR-4 | Cost | **$0/month.** No paid plan or card-required service |
| NFR-5 | Capacity | Bounded by the Gemini free-tier per-minute and per-day limits (check them in AI Studio). Fine for a demo and a few users; not for a team |
| NFR-6 | Deploy lead time | PR merged → production in < 10 min |
| NFR-7 | Rollback | < 2 min (Vercel instant rollback) |

### 4.3 Security and privacy

| ID | Requirement |
|---|---|
| SEC-1 | Secrets (`SESSION_SECRET`, Gemini key, Vercel token) live only in Vercel environment variables or GitHub secrets. They are never in the repo, the client bundle or logs. The CI build needs no runtime secrets |
| SEC-2 | Preview and production use different `SESSION_SECRET`s, and ideally different Gemini keys (separate quotas) |
| SEC-3 | Session cookie: `HttpOnly; Secure; SameSite=Lax`, HMAC-SHA256, constant-time check. Implemented |
| SEC-4 | The server refuses to start on Vercel without `GOOGLE_CLIENT_ID` (implemented). Previews also sit behind Vercel Deployment Protection |
| SEC-5 | The allowlist (D5) is the main abuse control on the free tier. Optionally add a Vercel Firewall rate-limit rule if it's available on Hobby |
| SEC-6 | No question or answer text is logged; only sign-in events and errors |
| SEC-7 | **Data use:** on the Gemini free tier, Google may use prompts and responses to improve its products. Acceptable for the fictional Kalvora corpus and test questions. **Not acceptable for real HR data or real employee questions**; that needs a paid, no-training tier |
| SEC-8 | `npm audit --omit=dev --audit-level=high` in CI. Dependabot for npm and Actions |
| SEC-9 | Actions pinned to commit SHAs, least-privilege `permissions:`, the Vercel CLI pinned to an exact version |
| SEC-10 | Policy text stays out of the repo: `data/` (including `data/index/`) is git-ignored, and the Supabase copy is server-only (SEC-11). A `BUNDLE_INDEX=1` build puts the index in the function bundle, never in `static/` |
| SEC-11 | Supabase: RLS on both tables with no policies, `EXECUTE` on the search function only for `service_role`. The app uses the secret key (`sb_secret_…`, Vercel env only). The publishable/anon key has no access. The legacy `service_role` JWT key stops working at the end of 2026, so use the new secret key |

---

## 5. Architecture

```
Browser (React SPA, static on the Vercel CDN)
   │  same origin: cookie + /api/*
   ▼
Vercel Function  /api/index   Node 24, bom1 (Mumbai), maxDuration 120 s, streaming on
   │   src/app.ts bundled by esbuild (includes supabase-js)
   │   auth → plan search → embed question → pgvector top-k (+ country filter) → stream answer
   ├──► Google              ID-token verification (certs cached)
   ├──► Gemini /embeddings  query vector (gemini-embedding-001, 768-dim)
   ├──► Supabase (ap-south-1)  rpc match_kalvora_chunks (HNSW cosine, secret key, one call per country)
   └──► Gemini /chat/completions  streaming, aborted when the client disconnects

GitHub Actions ──► npm run build:vercel ──► vercel deploy --prebuilt ──► Preview (stable alias) / Production
Developer PC   ──► VECTOR_STORE=supabase npm run ingest ──► Gemini embeddings ──► Supabase kalvora_chunks
```

**Why the Build Output API instead of `api/*.ts`:** the project uses TypeScript 7, whose package has no compiler JS API (`transpileModule` is missing), which Vercel's Node builder relies on. [scripts/build-vercel.mjs](scripts/build-vercel.mjs) bundles the function with esbuild and writes the routes itself:
1. Static files first.
2. `/api/*` → the function.
3. Everything else → `index.html`.

What CI builds is exactly what runs, and Vercel never compiles anything.

---

## 6. Code changes (done)

| # | Change | Files |
|---|---|---|
| C1 | Google sign-in | `src/auth.ts`, `web/src/{Login,Root}.tsx`, … |
| C2 | Handler split from the listener | `src/app.ts` (handler + Vercel default export), `src/server.ts` (local listener + static UI) |
| C3 | Provider-neutral config: `CHAT_*`, `EMBED_*`, `EMBED_DIMENSIONS`, `EMBED_DELAY_MS`, each falling back to `LMSTUDIO_*`. `CORPUS_DIR` only needed for ingestion | `src/config.ts` |
| C4 | Hosted-friendly model handling: no model-list or probe calls at start-up for hosted endpoints, 429-aware retries during ingestion, friendly rate-limit and key errors in the UI | `src/embedder.ts`, `src/answer.ts`, `src/app.ts` |
| C5 | File vector index: int8, per-vector scale, atomic save, incremental upserts and stale deletes | `src/fileIndex.ts` |
| C6 | One store interface for Chroma and the file index. Chroma loaded lazily, so it isn't in the bundle | `src/vectorStore.ts`, `src/retriever.ts`, `src/pipeline.ts`, `src/smoke.ts` |
| C7 | `npm run models`, `npm run export-index` (Chroma → file, no re-embed) | `src/models.ts`, `src/exportIndex.ts` |
| C8 | Deploy build (Build Output API v3, `nodejs24.x`, streaming, no body helpers). The body reader also handles a pre-parsed body | `scripts/build-vercel.mjs`, `vercel.json` (`git.deploymentEnabled: false`) |
| C9 | CI/CD workflows, deploy smoke script, Dependabot | `.github/…`, `scripts/smoke-deploy.mjs` |
| C10 | Tests: config, file index (ranking vs exact cosine, filter, round-trip), committed-index structure | `test/config.test.ts`, `test/fileIndex.test.ts`, `test/indexFile.test.ts` |
| C11 | `engines.node: 24.x`. `.gitignore` keeps all of `data/` out (the index too, since 2026-11-27) | `package.json`, `.gitignore`, `.gitattributes` |
| C12 | Docs | `README.md`, `.env.example`, this file |
| C13 | Supabase pgvector store (`VECTOR_STORE=supabase`, default on Vercel): schema migration, search function, incremental upserts, stale deletes, model check at start-up. The function region is set to `VERCEL_FUNCTION_REGION` (default `bom1`). The index is bundled only with `BUNDLE_INDEX=1`. `retrieval-smoke` now checks Supabase twice a week | `supabase/migrations/`, `src/supabaseStore.ts`, `src/vectorStore.ts`, `src/config.ts`, `scripts/build-vercel.mjs`, `.github/workflows/retrieval-smoke.yml`, `test/supabaseStore.test.ts` |

---

## 7. CI/CD pipeline (GitHub Actions)

### 7.1 Flow

```
PR opened/updated ─► verify ─► deploy-preview ─► alias STAGING_HOST ─► smoke (signed in + one question) ─► PR comment
push to main      ─► verify ─► [approval, if available] ─► deploy --prod ─► smoke (public) ─► (fail ⇒ vercel rollback)
Mon + Thu / manual ─► retrieval-smoke (Supabase vectors vs hosted embeddings; also keeps the free project active)
```

`verify` runs `npm ci`, typecheck, tests, `npm run build:vercel` and `npm audit`. Deploy jobs rebuild `.vercel/output` and upload it with `vercel deploy --prebuilt`. Fork PRs get no preview, because they get no secrets.

### 7.2 GitHub settings

| Setting | Value |
|---|---|
| Branch protection on `main` | Require PR, require the `verify` check, block force-pushes |
| Repo secrets | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `SMOKE_SESSION_SECRET` (= the **preview** `SESSION_SECRET`), `VERCEL_AUTOMATION_BYPASS_SECRET`, `SMOKE_EMBED_API_KEY`, `SUPABASE_SECRET_KEY` (for `retrieval-smoke`) |
| Repo variables | `STAGING_HOST`, `PRODUCTION_HOST`, `SMOKE_EMAIL` (must pass the preview allowlist), `EMBED_BASE_URL`, `EMBED_MODEL`, `EMBED_DIMENSIONS`, `SUPABASE_URL` |
| Environments | `preview`, `production`. Add a required reviewer to `production` if your plan allows it (D6) |

The production `SESSION_SECRET` is never stored in GitHub. That's why the production smoke test only checks endpoints that don't need sign-in.

### 7.3 Deploy smoke checks ([scripts/smoke-deploy.mjs](scripts/smoke-deploy.mjs))

| Check | Preview | Production |
|---|---|---|
| `/` and a deep link return the SPA | ✓ | ✓ |
| `/api/auth/config` → enabled with a client id | ✓ | ✓ |
| `POST /api/chat` without a cookie → 401 | ✓ | ✓ |
| Junk Google credential → 401 | ✓ | ✓ |
| Signed test cookie: `/api/info` ok, and the UK partner-leave question returns a `[KAL-GB-HR-01x` citation in < 30 s | ✓ | – |

Each preview smoke run makes 2 model calls, which is negligible against the free quota.

### 7.4 Google OAuth and previews

Google needs exact JavaScript origins; wildcards aren't allowed. So:
- Create one OAuth client for production, with the production domain as its origin.
- Create one for preview, with `https://<STAGING_HOST>` and the localhost origins.
- CI points the stable `STAGING_HOST` alias at each new PR build.

---

## 8. Environment variables

| Variable | Local `.env` | Vercel Preview | Vercel Production | Notes |
|---|---|---|---|---|
| `CHAT_BASE_URL` / `EMBED_BASE_URL` | empty (LM Studio) | `https://generativelanguage.googleapis.com/v1beta/openai/` | same | |
| `CHAT_API_KEY` / `EMBED_API_KEY` | empty | Gemini key (preview) | Gemini key (prod) | Sensitive |
| `CHAT_MODEL` | (auto) | Flash model id | same | Required for hosted endpoints |
| `EMBED_MODEL` | LM Studio nomic | `gemini-embedding-001` | same | Must match the stored vectors (checked at start-up) |
| `EMBED_DIMENSIONS` | empty | `768` | `768` | Must be 768: the Supabase column is `vector(768)` |
| `DOC_PREFIX` / `QUERY_PREFIX` | nomic prefixes | `""` | `""` | |
| `VECTOR_STORE` | `chroma` | (defaults to `supabase` on Vercel) | same | |
| `SUPABASE_URL` | for ingestion | `https://txkivrtpuiqphwvdanei.supabase.co` | same | One shared project is fine: previews only read |
| `SUPABASE_SECRET_KEY` | for ingestion | `sb_secret_…` | same (or a separate secret key) | Sensitive. Supabase > Project Settings > API Keys |
| `TOP_K` | 6 | 6 | 6 | |
| `GOOGLE_CLIENT_ID` | optional | preview client | prod client | §7.4 |
| `SESSION_SECRET` | 32+ chars | random, preview-only | random, prod-only | Sensitive |
| `ALLOWED_EMAILS` / `ALLOWED_DOMAINS` | – | your accounts + `SMOKE_EMAIL` | your accounts | D5 |
| `SESSION_TTL_HOURS` | 168 | 24 | 168 | |
| `CORPUS_DIR`, `EMBED_DELAY_MS` | ingestion only | – | – | |

---

## 9. Runbook: loading Supabase with Gemini embeddings

1. In `.env`, set the Gemini variables (see `.env.example`), `EMBED_DIMENSIONS=768`, `VECTOR_STORE=supabase`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Use `EMBED_DELAY_MS=1000` or more to stay under the per-minute limit.
2. `npm run models`: confirm the key works and pick `CHAT_MODEL`.
3. `npm run ingest:dry`: expect 7,500 chunks.
4. `npm run ingest -- --reset`: embeds about 118 batches and upserts each one to Supabase as it goes. If the daily quota runs out, re-run without `--reset` the next day; only missing chunks are embedded.
5. `npm run smoke`: all labelled checks must pass. If the country accuracy drops, try `TOP_K=8` or check `EMBED_DIMENSIONS`.
6. Open a PR. The preview smoke test exercises Supabase end to end. Nothing needs committing for a data change.

When policies change, re-run step 4 without `--reset`: only changed sections are re-embedded, and removed sections are deleted. Production picks this up immediately, with no deploy.

New Supabase project: apply [supabase/migrations](supabase/migrations) first (SQL editor or `supabase db push`).

---

## 10. Rollout

| Phase | Work | Exit criteria |
|---|---|---|
| **0. Accounts** | Gemini API key (AI Studio). Vercel Hobby account + project (Framework: Other). Two Google OAuth clients (§7.4). Supabase project `kalvora-hr`, schema applied (done 2026-11-25); copy its secret key | Keys in hand |
| **1. Vectors** | §9 runbook | `npm run smoke` passes with Gemini against Supabase |
| **2. Local check** | `npm run server` with the Gemini settings, sign in, ask 10 questions | Answers cited, first token in a few seconds |
| **3. Platform** | Vercel env vars per §8, Deployment Protection on previews, then one manual `npm run build:vercel && vercel deploy --prebuilt` | Deployment works, sign-in works |
| **4. Pipeline** | Repo secrets, variables, environments and branch protection (§7.2). Open a test PR | Preview + smoke + comment. Merge deploys to production and smoke passes |
| **5. Live** | Share with the allowlisted users | §12 met |

---

## 11. Cost

| Item | Plan | Cost |
|---|---|---|
| Hosting + function | Vercel Hobby | $0 (within Hobby's included usage) |
| Chat + embeddings | Gemini API free tier | $0 (rate-limited) |
| Vector store | Supabase Free (500 MB database; pauses after a week without use) | $0 |
| CI/CD | GitHub Actions | $0 (unlimited on public repos; 2,000 min/month on private) |
| Sign-in | Google Identity Services | $0 |
| **Total** | | **$0/month** |

**When to start paying:** if this becomes a company tool (Hobby terms, SEC-7), or if it needs more users than the free model quota allows. Then move to Vercel Pro (~$20/month) and a paid model tier. The code needs no change, only environment variables.

---

## 12. Acceptance criteria

- [ ] `npm run smoke` passes with Gemini vectors in Supabase.
- [ ] An allowlisted user can sign in on production and get a cited answer. A non-allowlisted account gets "not allowed".
- [ ] `/api/chat` and `/api/info` return 401 without a cookie, on preview and production.
- [ ] First token within NFR-1, over 10 questions.
- [ ] Hitting the rate limit shows the friendly message (FR-9). Test by sending questions quickly.
- [ ] A PR gets a preview comment, and sign-in works on `STAGING_HOST`.
- [ ] Merging deploys to production and passes smoke. A deliberately broken deploy is rolled back.
- [ ] `retrieval-smoke` passes on a manual run.
- [ ] No secrets in the repo or in `.vercel/output/static`.

---

## 13. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Free-tier rate limits hit with several users | Medium | Answers fail for a minute | Friendly message (FR-9), allowlist, separate preview/prod keys. Groq as a drop-in alternative |
| Google changes free-tier limits, model names or data terms | Medium | Medium | Everything is configured through environment variables. `retrieval-smoke` runs twice a week. Re-check terms (SEC-7) |
| Gemini retrieval quality differs from nomic | Low–Medium | Medium | `npm run smoke` gates the rollout (§9 step 5) |
| Re-embed blocked by the daily quota | Medium | Ingestion takes 2 days | Incremental ingestion, upserted per batch (§9 step 4) |
| Supabase free project paused after a week without use | Medium (quiet weeks) | All answers fail until it's restored | `retrieval-smoke` queries it Mon + Thu. If paused, restore it in the dashboard (takes a few minutes). The error message names the cause. Supabase Pro ($25/month) never pauses |
| Supabase unreachable or slow | Low | Answers fail or slow | Function and database are both in Mumbai. Fallback: `VECTOR_STORE=file` with `BUNDLE_INDEX=1` (needs a Gemini-built `data/index`) |
| Build Output API details (`nodejs24.x`, `--prebuilt` without `vercel build`) behave differently than expected | Low | Deploy fails | Phase 3 manual deploy catches it before CI. Fallback runtime `nodejs22.x` |
| Stored vectors and `EMBED_MODEL` out of sync | Low | All answers fail | Start-up check against `kalvora_index_meta`, plus dimensions on every query |
| Hobby used for commercial purposes | – | Breaks Vercel terms | D4: move to Pro first |

---

## 14. Still to verify on the first deploy

- **Gemini model ids and limits.** Check the model ids and current free-tier limits in AI Studio. The docs page doesn't list free-tier numbers, and names change often.
- **Gemini embedding dimensions.** Check that `dimensions` (768) is honoured through the OpenAI-compatible endpoint. Ingestion refuses anything but 768, because the Supabase column is `vector(768)`. If the endpoint ignores it, change the column size in a new migration and in `SCHEMA_DIM` (HNSW supports up to 2,000 dimensions).
- **Function region.** Check that the `regions: ["bom1"]` setting in `.vc-config.json` is honoured with `--prebuilt` (the deployment's function details should show `bom1`). If it isn't, set the region in the Vercel project settings.
- **Vercel deploy details.**
  - Check that `vercel deploy --prebuilt` accepts output written without `vercel build` (no `builds.json`), including with `--prod`.
  - Check that the `nodejs24.x` runtime name is accepted.
  - Check the `vercel rollback` syntax for the pinned CLI (65.11.0).
- **Hobby features.** Check that Deployment Protection and the automation bypass secret are available on Hobby.

## 15. Out of scope

- Per-user rate limits or usage analytics (would need a store such as Upstash Redis free tier).
- Automated ingestion from a document system.
- Chat history across devices.
- An answer-quality evaluation in CI (today's smoke checks retrieval only).
