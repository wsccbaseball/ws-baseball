-- Pitch-upload scoring dispatch.
-- Not applied to the live database. The coach reviews and runs this.
-- Setup: supabase/PITCH_SCORING_DISPATCH.md
--
-- After each INSERT statement on public.pitches, one row records the time.
-- A pg_cron job wakes every minute and, once inserts have been quiet for 90
-- seconds, POSTs one GitHub repository_dispatch (event type pitches-uploaded).
-- The uploader's 500-row batches therefore start one scoring run, not one
-- run per row and not one run per batch.
--
-- The GitHub token is NOT in this file. Store it in Supabase Vault under the
-- name github_actions_dispatch_token before relying on the dispatch. Until
-- that secret exists, uploads still succeed and the 08:00 UTC workflow is
-- the backup. See the setup doc.

-- @testable
-- Re-runnable portion: bookmark table, decision helper, statement trigger.
-- Local tests execute from here through @end-testable. The live section
-- below needs pg_net, vault, and pg_cron.

create schema if not exists private;

revoke all on schema private from public;
do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema private from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema private from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on schema private from service_role';
  end if;
end
$priv$;

create table if not exists private.pitch_upload_dispatch (
  id smallint primary key default 1 check (id = 1),
  last_insert_at timestamptz,
  last_batch_rows bigint,
  last_dispatched_at timestamptz,
  last_request_id bigint
);

alter table private.pitch_upload_dispatch
  add column if not exists last_batch_rows bigint;

alter table private.pitch_upload_dispatch
  add column if not exists last_dispatched_at timestamptz;

alter table private.pitch_upload_dispatch
  add column if not exists last_request_id bigint;

insert into private.pitch_upload_dispatch (id)
values (1)
on conflict (id) do nothing;

comment on table private.pitch_upload_dispatch is
  'One row. Statement-level pitch inserts bump last_insert_at. pg_cron sends one GitHub repository_dispatch after inserts go quiet.';

alter table private.pitch_upload_dispatch enable row level security;

revoke all on table private.pitch_upload_dispatch from public;
do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table private.pitch_upload_dispatch from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table private.pitch_upload_dispatch from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on table private.pitch_upload_dispatch from service_role';
  end if;
end
$priv$;

-- Quiet-window decision. Kept separate so it can be tested without HTTP.
-- 'wait' beats 'missing-token': an in-progress upload does not warn every minute.
create or replace function private.pitch_scoring_dispatch_decision(
  last_insert_at timestamptz,
  last_dispatched_at timestamptz,
  now_at timestamptz,
  has_token boolean,
  quiet interval default interval '90 seconds'
) returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when last_insert_at is null then 'idle'
    when last_dispatched_at is not null and last_dispatched_at >= last_insert_at then 'idle'
    when last_insert_at > now_at - quiet then 'wait'
    when has_token is not true then 'missing-token'
    else 'dispatch'
  end;
$function$;

comment on function private.pitch_scoring_dispatch_decision(timestamptz, timestamptz, timestamptz, boolean, interval) is
  'idle, wait, missing-token, or dispatch. 90 seconds of quiet collapses an upload burst to one dispatch.';

-- Fires once per INSERT statement. Transition table "inserted" is the new
-- rows for that statement, so a 500-row batch counts as one bookmark.
-- A failure here must not fail the pitch insert. The nightly workflow remains.
create or replace function private.note_pitch_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  batch_rows bigint;
begin
  select count(*) into batch_rows from inserted;
  if batch_rows = 0 then
    return null;
  end if;
  insert into private.pitch_upload_dispatch as bookmark (id, last_insert_at, last_batch_rows)
  values (1, clock_timestamp(), batch_rows)
  on conflict (id) do update
    set last_insert_at = excluded.last_insert_at,
        last_batch_rows = excluded.last_batch_rows;
  return null;
exception
  when others then
    raise warning 'pitch upload dispatch bookmark failed: %', sqlerrm;
    return null;
end;
$function$;

comment on function private.note_pitch_insert() is
  'Statement-level bookmark of public.pitches inserts. Does not call GitHub.';

revoke all on function private.note_pitch_insert() from public;
revoke all on function private.pitch_scoring_dispatch_decision(timestamptz, timestamptz, timestamptz, boolean, interval) from public;
do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function private.note_pitch_insert() from anon';
    execute 'revoke all on function private.pitch_scoring_dispatch_decision(timestamptz, timestamptz, timestamptz, boolean, interval) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function private.note_pitch_insert() from authenticated';
    execute 'revoke all on function private.pitch_scoring_dispatch_decision(timestamptz, timestamptz, timestamptz, boolean, interval) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function private.note_pitch_insert() from service_role';
    execute 'revoke all on function private.pitch_scoring_dispatch_decision(timestamptz, timestamptz, timestamptz, boolean, interval) from service_role';
  end if;
end
$priv$;

drop trigger if exists pitches_note_upload on public.pitches;
create trigger pitches_note_upload
  after insert on public.pitches
  referencing new table as inserted
  for each statement
  execute function private.note_pitch_insert();

comment on trigger pitches_note_upload on public.pitches is
  'One bookmark per INSERT statement. Upload batches share one later dispatch.';

-- @end-testable

-- @live-only
-- Requires the extensions below. Safe to re-run: cron.schedule upserts by name.

create extension if not exists pg_net;
create extension if not exists supabase_vault;
create extension if not exists pg_cron with schema pg_catalog;

-- @dispatch-function
create or replace function private.dispatch_pitch_scoring()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_last_insert timestamptz;
  v_last_dispatched timestamptz;
  v_has_token boolean;
  v_decision text;
  v_token text;
  v_repo text := 'wsccbaseball/ws-baseball';
  v_request_id bigint;
begin
  select last_insert_at, last_dispatched_at
    into v_last_insert, v_last_dispatched
    from private.pitch_upload_dispatch
   where id = 1
   for update;

  select exists (
    select 1
      from vault.decrypted_secrets
     where name = 'github_actions_dispatch_token'
       and nullif(btrim(decrypted_secret), '') is not null
  ) into v_has_token;

  v_decision := private.pitch_scoring_dispatch_decision(
    v_last_insert,
    v_last_dispatched,
    clock_timestamp(),
    v_has_token
  );

  if v_decision = 'missing-token' then
    raise warning 'github_actions_dispatch_token is not in Supabase Vault. Pitch inserts were bookmarked but scoring was not dispatched. The 08:00 UTC workflow is the backup.';
    return;
  end if;

  if v_decision <> 'dispatch' then
    return;
  end if;

  select btrim(decrypted_secret)
    into v_token
    from vault.decrypted_secrets
   where name = 'github_actions_dispatch_token'
   limit 1;

  -- event_type pitches-uploaded must match .github/workflows/stuff-plus.yml.
  -- No rescore flags: this run null-fills, the same as the nightly cron.
  select net.http_post(
    url := 'https://api.github.com/repos/' || v_repo || '/dispatches',
    body := jsonb_build_object(
      'event_type', 'pitches-uploaded',
      'client_payload', jsonb_build_object(
        'source', 'pitches-insert',
        'last_insert_at', v_last_insert
      )
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'ws-baseball-pitch-dispatch',
      'Authorization', 'Bearer ' || v_token
    ),
    timeout_milliseconds := 10000
  ) into v_request_id;

  update private.pitch_upload_dispatch
     set last_dispatched_at = clock_timestamp(),
         last_request_id = v_request_id
   where id = 1;
end;
$function$;

comment on function private.dispatch_pitch_scoring() is
  'POST repository_dispatch pitches-uploaded after pitch inserts have been quiet for 90 seconds.';
-- @end-dispatch-function

revoke all on function private.dispatch_pitch_scoring() from public;
do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function private.dispatch_pitch_scoring() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function private.dispatch_pitch_scoring() from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function private.dispatch_pitch_scoring() from service_role';
  end if;
end
$priv$;

select cron.schedule(
  'dispatch-scoring-after-pitch-upload',
  '* * * * *',
  $cron$select private.dispatch_pitch_scoring()$cron$
);
-- @end-live-only
