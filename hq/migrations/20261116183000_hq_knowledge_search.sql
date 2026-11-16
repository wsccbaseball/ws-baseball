-- Knowledge search.
-- Not applied to the live database. Apply after review (see the header
-- of hq/SCHEMA.md). Run this file in the Supabase SQL editor as the
-- database owner.
--
-- Adds pg_trgm (extensions schema), indexes, and hq_search_knowledge.
-- Does not insert, update, or delete rows in hq_knowledge_items.
-- The Knowledge page searches through the REST API before this runs.
-- After it runs, the page calls hq_search_knowledge so the trigram
-- index can serve the same search. notify pgrst reloads the API cache.
--
-- Search rules (kept in sync with hq/knowledge-search.js):
--   trim, strip LIKE wildcards, first 80 characters;
--   case-insensitive match on summary, source_text, and tags;
--   spaces and hyphens are the same separator ("pop time" = "pop-time");
--   optional exact tag filter;
--   newest created_at, then id; page size defaults to 25 and caps at 50.

create schema if not exists extensions;

create extension if not exists pg_trgm with schema extensions;

-- Immutable so it can be indexed. plpgsql is not inlined, which keeps the
-- index expression equal to the call in hq_search_knowledge.
create or replace function public.hq_knowledge_search_blob(
  summary text,
  source_text text,
  tags text[]
) returns text
language plpgsql
immutable
parallel safe
set search_path = public
as $$
begin
  return regexp_replace(
    coalesce(summary, '') || ' ' || coalesce(source_text, '') || ' ' || coalesce(array_to_string(tags, ' '), ''),
    '[[:space:]-]+',
    ' ',
    'g'
  );
end;
$$;

comment on function public.hq_knowledge_search_blob(text, text, text[]) is
  'Normalized summary + source text + tags for the knowledge trigram index. Concatenates its arguments only; does not read the table.';

revoke all on function public.hq_knowledge_search_blob(text, text, text[]) from public;
grant execute on function public.hq_knowledge_search_blob(text, text, text[]) to anon, authenticated, service_role;

create index if not exists hq_knowledge_items_search_trgm
  on public.hq_knowledge_items
  using gin (public.hq_knowledge_search_blob(summary, source_text, tags) extensions.gin_trgm_ops);

create index if not exists hq_knowledge_items_tags_gin
  on public.hq_knowledge_items
  using gin (tags);

create index if not exists hq_knowledge_items_created_id_idx
  on public.hq_knowledge_items (created_at desc, id desc);

create or replace function public.hq_search_knowledge(
  q text default '',
  tag text default '',
  page_limit integer default 25,
  page_offset integer default 0
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      left(
        btrim(replace(replace(replace(btrim(coalesce(q, '')), '\', ''), '%', ''), '_', '')),
        80
      ) as raw_needle,
      btrim(coalesce(tag, '')) as tag_filter,
      least(greatest(coalesce(page_limit, 25), 1), 50) as lim,
      greatest(coalesce(page_offset, 0), 0) as off
  ),
  norm as (
    select
      case
        when regexp_replace(raw_needle, '[[:space:]-]+', '', 'g') = '' then ''
        else regexp_replace(raw_needle, '[[:space:]-]+', ' ', 'g')
      end as needle,
      tag_filter,
      lim,
      off
    from params
  ),
  matched as (
    select k.*
    from public.hq_knowledge_items k
    cross join norm n
    where (
      n.needle = ''
      or public.hq_knowledge_search_blob(k.summary, k.source_text, k.tags) ilike '%' || n.needle || '%'
    )
    and (
      n.tag_filter = ''
      or k.tags @> array[n.tag_filter]::text[]
    )
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'items', coalesce((
      select jsonb_agg(to_jsonb(page_row) order by page_row.created_at desc, page_row.id desc)
      from (
        select
          id,
          source_url,
          source_text,
          summary,
          tags,
          linked_player_id,
          created_at
        from matched
        order by created_at desc, id desc
        limit (select lim from norm)
        offset (select off from norm)
      ) page_row
    ), '[]'::jsonb)
  );
$$;

comment on function public.hq_search_knowledge(text, text, integer, integer) is
  'Paged, case-insensitive knowledge search over summary, source text, and tags. security invoker: hq_knowledge_items RLS applies. Does not write.';

revoke all on function public.hq_search_knowledge(text, text, integer, integer) from public;
grant execute on function public.hq_search_knowledge(text, text, integer, integer) to anon, authenticated, service_role;

analyze public.hq_knowledge_items;

notify pgrst, 'reload schema';
