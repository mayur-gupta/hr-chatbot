-- Vector store for the deployed app (VECTOR_STORE=supabase). Applied to the kalvora-hr project
-- (ref txkivrtpuiqphwvdanei, ap-south-1) on 2026-11-25. Apply to a new project with the Supabase
-- SQL editor or `supabase db push`.

create extension if not exists vector with schema extensions;

-- One row per policy chunk. 768 = gemini-embedding-001 at EMBED_DIMENSIONS=768
-- (src/supabaseStore.ts SCHEMA_DIM must match).
create table public.kalvora_chunks (
  id            text primary key,
  doc_id        text not null,
  country_code  text not null,
  content_hash  text not null,
  text          text not null,
  metadata      jsonb not null,
  embedding     extensions.vector(768) not null,
  updated_at    timestamptz not null default now()
);
create index kalvora_chunks_doc_id_idx on public.kalvora_chunks (doc_id);
create index kalvora_chunks_country_idx on public.kalvora_chunks (country_code);
create index kalvora_chunks_embedding_idx on public.kalvora_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- Which embedding model built the vectors (checked by the app at start-up and by ingestion).
create table public.kalvora_index_meta (
  id            smallint primary key default 1 check (id = 1),
  embed_model   text not null,
  dim           integer not null,
  doc_prefix    text not null default '',
  query_prefix  text not null default '',
  updated_at    timestamptz not null default now()
);

-- Server-only access: RLS on with no policies, so anon/authenticated keys see nothing;
-- the secret (service_role) key bypasses RLS.
alter table public.kalvora_chunks enable row level security;
alter table public.kalvora_index_meta enable row level security;
revoke all on public.kalvora_chunks, public.kalvora_index_meta from anon, authenticated;

-- Top-k cosine search with an optional country filter. Iterative scan keeps the HNSW index
-- returning k rows even when the filter discards most candidates; the outer ORDER BY restores
-- exact order after relaxed_order.
create or replace function public.match_kalvora_chunks(
  query_embedding extensions.vector(768),
  match_count     integer,
  filter_country  text default null
)
returns table (id text, text text, metadata jsonb, distance double precision)
language sql
stable
security invoker
set search_path = ''
set hnsw.ef_search = 100
set hnsw.iterative_scan = relaxed_order
as $$
  with candidates as materialized (
    select c.id, c.text, c.metadata, c.embedding operator(extensions.<=>) query_embedding as distance
    from public.kalvora_chunks c
    where filter_country is null or c.country_code = filter_country
    order by c.embedding operator(extensions.<=>) query_embedding
    limit match_count
  )
  select * from candidates order by distance;
$$;

revoke execute on function public.match_kalvora_chunks(extensions.vector, integer, text) from public, anon, authenticated;
grant execute on function public.match_kalvora_chunks(extensions.vector, integer, text) to service_role;
