-- Run this in Supabase SQL Editor.
-- Improves recall for Hebrew queries by combining FTS + trigram similarity.

create extension if not exists pg_trgm;

-- Helpful indexes
create index if not exists idx_chunks_text_trgm
  on public.chunks using gin (text gin_trgm_ops);

create index if not exists idx_chunks_section_trgm
  on public.chunks using gin (section gin_trgm_ops);

create index if not exists idx_chunks_text_tsv
  on public.chunks using gin (to_tsvector('simple', coalesce(text, '')));

create index if not exists idx_chunks_section_tsv
  on public.chunks using gin (to_tsvector('simple', coalesce(section, '')));

-- Hybrid search RPC
create or replace function public.search_chunks(q text, k int default 8)
returns table (
  source_title text,
  source_url text,
  section text,
  locator jsonb,
  text text,
  rank double precision
)
language sql
stable
as $$
  with query as (
    select
      trim(coalesce(q, '')) as raw_q,
      websearch_to_tsquery('simple', trim(coalesce(q, ''))) as tsq
  ),
  scored as (
    select
      s.title as source_title,
      s.url as source_url,
      c.section,
      c.locator,
      c.text,
      (
        -- FTS relevance
        1.6 * ts_rank_cd(
          to_tsvector('simple', coalesce(c.section, '') || ' ' || coalesce(c.text, '')),
          (select tsq from query)
        )
        +
        -- fuzzy match over main text
        1.1 * similarity(coalesce(c.text, ''), (select raw_q from query))
        +
        -- fuzzy match over section/title-like fields
        0.9 * similarity(coalesce(c.section, ''), (select raw_q from query))
        +
        -- exact-ish phrase boost
        case
          when coalesce(c.text, '') ilike ('%' || (select raw_q from query) || '%') then 0.35
          else 0
        end
      )::double precision as rank
    from public.chunks c
    join public.sources s on s.id = c.source_id
    where
      (
        to_tsvector('simple', coalesce(c.section, '') || ' ' || coalesce(c.text, ''))
          @@ (select tsq from query)
        or coalesce(c.text, '') % (select raw_q from query)
        or coalesce(c.section, '') % (select raw_q from query)
        or coalesce(c.text, '') ilike ('%' || (select raw_q from query) || '%')
      )
  )
  select
    source_title,
    source_url,
    section,
    locator,
    text,
    rank
  from scored
  where rank > 0.02
  order by rank desc
  limit greatest(1, coalesce(k, 8));
$$;
