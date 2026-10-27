"""Upload trigger and null-GameID skip. SQL runs against local Postgres.

The dispatch migration is not applied to Supabase here. The testable half
(bookmark, statement trigger, quiet-window decision) is applied to a local
database. pg_net / vault / cron are not required for that half.
"""
import importlib.util
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO

import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
import scoring_game_id as game_id


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MIGRATION = os.path.join(
    ROOT, 'supabase', 'migrations', '20261027120000_pitch_upload_scoring_dispatch.sql')
WORKFLOW = os.path.join(ROOT, '.github', 'workflows', 'stuff-plus.yml')


def _between(text, start, end):
    i = text.index(start)
    j = text.index(end)
    return text[i + len(start):j]


class NullGameIdTests(unittest.TestCase):
    def test_blank_values_are_missing_and_real_ids_are_kept(self):
        self.assertTrue(game_id.game_id_missing(None))
        self.assertTrue(game_id.game_id_missing(float('nan')))
        self.assertTrue(game_id.game_id_missing(''))
        self.assertTrue(game_id.game_id_missing('  \t'))
        self.assertTrue(game_id.game_id_missing(pd.NA))
        self.assertFalse(game_id.game_id_missing('2026-03-01-wal'))
        self.assertFalse(game_id.game_id_missing('0'))
        self.assertFalse(game_id.game_id_missing(0))

    def test_exclude_drops_null_game_id_and_logs_them(self):
        frame = pd.DataFrame([
            {'id': 1, 'GameID': None},
            {'id': 2, 'GameID': ''},
            {'id': 3, 'GameID': '   '},
            {'id': 4, 'GameID': 'G-4'},
            {'id': 5, 'GameID': float('nan')},
        ])
        kept, count, ids = game_id.exclude_missing_game_id(frame)
        self.assertEqual(list(kept['id']), [4])
        self.assertEqual(count, 4)
        self.assertEqual(ids, [1, 2, 3, 5])
        buf = StringIO()
        with redirect_stdout(buf):
            game_id.log_null_game_id(count, ids, 'unscored Stuff+')
        line = buf.getvalue().strip()
        self.assertIn('SKIP null GameID: 4 unscored Stuff+ pitch(es) have no GameID.', line)
        self.assertIn('They are not scored and will not get a games row.', line)
        self.assertIn('Example ids: 1, 2, 3, 5', line)

    def test_all_null_game_id_frame_is_dropped(self):
        # A positioning export: no GameID column values, both teams Wal_Sen.
        frame = pd.DataFrame({'id': [10, 11], 'GameID': [None, None], 'PitcherTeam': ['Wal_Sen', 'Wal_Sen']})
        kept, count, ids = game_id.exclude_missing_game_id(frame)
        self.assertTrue(kept.empty)
        self.assertEqual(count, 2)
        self.assertEqual(ids, [10, 11])

    def test_missing_column_refuses_to_guess(self):
        frame = pd.DataFrame({'id': [1], 'Pitcher': ['Ace']})
        with self.assertRaises(KeyError):
            game_id.exclude_missing_game_id(frame)

    def test_quiet_when_every_pitch_has_a_game(self):
        frame = pd.DataFrame({'id': [1], 'GameID': ['G-1']})
        kept, count, ids = game_id.exclude_missing_game_id(frame)
        self.assertEqual(list(kept['id']), [1])
        self.assertEqual((count, ids), (0, []))
        buf = StringIO()
        with redirect_stdout(buf):
            game_id.log_null_game_id(count, ids, 'unscored Stuff+')
        self.assertEqual(buf.getvalue(), '')

    def test_log_truncates_the_sample(self):
        buf = StringIO()
        with redirect_stdout(buf):
            game_id.log_null_game_id(10, list(range(1, 11)), 'split-PA', 'They are not folded and will not get a games row.')
        line = buf.getvalue().strip()
        self.assertIn('Example ids: 1, 2, 3, 4, 5, 6, 7, 8 (+2 more)', line)
        self.assertIn('not folded', line)

    def test_scorers_pull_game_id_and_the_fold_skips_it(self):
        stuff = _load('score_stuff_for_trigger', os.path.join(ROOT, 'stuff', 'score_stuff.py'))
        location = _load('score_location_for_trigger', os.path.join(ROOT, 'location', 'score_location.py'))
        fold = _load('fix_split_pas_for_trigger', os.path.join(ROOT, 'season', 'fix_split_pas.py'))
        self.assertIn('GameID', stuff.PULL_COLS)
        self.assertIn('GameID', location.SELECT_COLS)
        kept, skipped = fold.rows_for_fold([
            {'id': 1, 'GameID': None, 'Inning': 1},
            {'id': 2, 'GameID': '   ', 'Inning': 1},
            {'id': 3, 'GameID': 'G-3', 'Inning': 1},
        ])
        self.assertEqual([row['id'] for row in kept], [3])
        self.assertEqual([row['id'] for row in skipped], [1, 2])


class WorkflowContractTests(unittest.TestCase):
    def test_cron_stays_and_upload_dispatch_collapses(self):
        with open(WORKFLOW, encoding='utf-8') as handle:
            text = handle.read()
        with open(MIGRATION, encoding='utf-8') as handle:
            sql = handle.read()
        self.assertIn("cron: '0 8 * * *'", text)
        self.assertIn('workflow_dispatch:', text)
        self.assertIn('repository_dispatch:', text)
        self.assertIn('types: [pitches-uploaded]', text)
        self.assertIn('pitches-uploaded', sql)
        self.assertIn('group: stuff-plus-scoring', text)
        self.assertIn('cancel-in-progress: false', text)
        self.assertIn("github.event.inputs.stuff_rescore || github.event.client_payload.stuff_rescore || '0'", text)
        self.assertIn("github.event.inputs.location_rescore || github.event.client_payload.location_rescore || '0'", text)
        self.assertIn('github_actions_dispatch_token', sql)
        self.assertIn('for each statement', sql)
        self.assertNotIn('for each row', sql)
        # The token is never written into the migration.
        self.assertNotIn('github_pat_', sql)
        self.assertNotIn('ghp_', sql)


def _psql(script):
    return subprocess.run(
        ['sudo', '-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-f', '-'],
        input=script,
        text=True,
        capture_output=True,
        check=False,
    )


class DispatchSqlTests(unittest.TestCase):
    def test_statement_trigger_and_quiet_window(self):
        with open(MIGRATION, encoding='utf-8') as handle:
            migration = handle.read()
        body = _between(migration, '-- @testable\n', '\n-- @end-testable')
        dispatch_fn = _between(migration, '-- @dispatch-function\n', '\n-- @end-dispatch-function')
        script = r'''
drop schema if exists private cascade;
drop schema if exists net cascade;
drop schema if exists vault cascade;
drop table if exists public.pitches;
drop role if exists uploader;
create role uploader nologin;
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$roles$;
create table public.pitches (
  id bigint generated always as identity primary key,
  "GameID" text
);
''' + body + r'''
-- Re-running the bookmark section must not duplicate the trigger or the row.
''' + body + r'''
insert into public.pitches ("GameID") values ('g1'), (null), ('  '), ('g2');
insert into public.pitches ("GameID") values ('g3'), ('g4');
insert into public.pitches ("GameID") select 'nope' where false;
update public.pitches set "GameID" = 'g1b' where "GameID" = 'g1';

do $check$
declare
  batches bigint;
  rows_in_table int;
  is_statement boolean;
  is_insert boolean;
  decision text;
  bookmark_at timestamptz;
  r record;
begin
  select last_batch_rows, last_insert_at
    into batches, bookmark_at
    from private.pitch_upload_dispatch
   where id = 1;
  if batches is distinct from 2 then
    raise exception 'expected last batch of 2 rows, got %', batches;
  end if;
  if bookmark_at is null then
    raise exception 'bookmark was not written';
  end if;

  select count(*) into rows_in_table from private.pitch_upload_dispatch;
  if rows_in_table <> 1 then
    raise exception 'upload burst must collapse to one bookmark row, got %', rows_in_table;
  end if;

  select (tgtype & 1) = 0, (tgtype & 4) <> 0
    into is_statement, is_insert
    from pg_trigger
   where tgname = 'pitches_note_upload' and not tgisinternal;
  if not is_statement or not is_insert then
    raise exception 'trigger must be statement-level insert, statement=% insert=%', is_statement, is_insert;
  end if;

  -- Two batches just landed. The quiet window has not elapsed, so this is one wait, not two dispatches.
  decision := private.pitch_scoring_dispatch_decision(
    bookmark_at, null, clock_timestamp(), true);
  if decision <> 'wait' then
    raise exception 'fresh upload must wait, got %', decision;
  end if;

  -- After the file has been quiet, the same single bookmark dispatches once.
  update private.pitch_upload_dispatch
     set last_insert_at = clock_timestamp() - interval '2 minutes'
   where id = 1;
  select private.pitch_scoring_dispatch_decision(
           last_insert_at, last_dispatched_at, clock_timestamp(), true)
    into decision
    from private.pitch_upload_dispatch
   where id = 1;
  if decision <> 'dispatch' then
    raise exception 'quiet bookmark must dispatch once, got %', decision;
  end if;

  update private.pitch_upload_dispatch
     set last_dispatched_at = clock_timestamp()
   where id = 1;
  select private.pitch_scoring_dispatch_decision(
           last_insert_at, last_dispatched_at, clock_timestamp(), true)
    into decision
    from private.pitch_upload_dispatch
   where id = 1;
  if decision <> 'idle' then
    raise exception 'a sent bookmark must not dispatch again, got %', decision;
  end if;

  for r in
    select * from (values
      ('idle no insert', null::timestamptz, null::timestamptz, timestamptz '2026-10-27 12:00:00+00', true, 'idle'),
      ('wait recent', timestamptz '2026-10-27 11:59:30+00', null::timestamptz, timestamptz '2026-10-27 12:00:00+00', true, 'wait'),
      ('dispatch quiet', timestamptz '2026-10-27 11:58:00+00', null::timestamptz, timestamptz '2026-10-27 12:00:00+00', true, 'dispatch'),
      ('boundary exact 90s', timestamptz '2026-10-27 11:58:30+00', null::timestamptz, timestamptz '2026-10-27 12:00:00+00', true, 'dispatch'),
      ('already sent', timestamptz '2026-10-27 11:50:00+00', timestamptz '2026-10-27 11:52:00+00', timestamptz '2026-10-27 12:00:00+00', true, 'idle'),
      ('newer than last dispatch', timestamptz '2026-10-27 11:58:00+00', timestamptz '2026-10-27 11:40:00+00', timestamptz '2026-10-27 12:00:00+00', true, 'dispatch'),
      ('quiet but no token', timestamptz '2026-10-27 11:58:00+00', null::timestamptz, timestamptz '2026-10-27 12:00:00+00', false, 'missing-token'),
      ('recent no token still waits', timestamptz '2026-10-27 11:59:50+00', null::timestamptz, timestamptz '2026-10-27 12:00:00+00', false, 'wait')
    ) as t(label, last_insert, last_sent, now_at, has_token, expected)
  loop
    decision := private.pitch_scoring_dispatch_decision(r.last_insert, r.last_sent, r.now_at, r.has_token);
    if decision is distinct from r.expected then
      raise exception '%: expected %, got %', r.label, r.expected, decision;
    end if;
  end loop;
end
$check$;

grant insert on public.pitches to uploader;
set role uploader;
insert into public.pitches ("GameID") values ('from-uploader');
reset role;

do $uploader$
declare
  batches bigint;
begin
  select last_batch_rows into batches from private.pitch_upload_dispatch where id = 1;
  if batches is distinct from 1 then
    raise exception 'uploader insert did not bookmark one row, got %', batches;
  end if;
end
$uploader$;

set role uploader;
do $denied$
begin
  begin
    perform 1 from private.pitch_upload_dispatch;
    raise exception 'uploader could read the bookmark table';
  exception
    when insufficient_privilege then
      null;
  end;
end
$denied$;
reset role;

create schema if not exists net;
create table if not exists net.calls (
  id bigint generated always as identity primary key,
  url text,
  body jsonb,
  headers jsonb
);
-- Stand-in for pg_net. Records the call and returns an id. No HTTP.
create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 2000
) returns bigint
language plpgsql
as $stub$
begin
  insert into net.calls (url, body, headers) values (url, body, headers);
  return 42;
end;
$stub$;

create schema if not exists vault;
create table if not exists vault.decrypted_secrets (
  name text,
  decrypted_secret text
);
insert into vault.decrypted_secrets (name, decrypted_secret)
values ('github_actions_dispatch_token', 'test-token-not-real');
''' + dispatch_fn + r'''
update private.pitch_upload_dispatch
   set last_insert_at = clock_timestamp() - interval '2 minutes',
       last_dispatched_at = null,
       last_request_id = null
 where id = 1;

select private.dispatch_pitch_scoring();

do $sent$
declare
  sent_at timestamptz;
  request_id bigint;
  calls int;
  target text;
  event_type text;
  auth_header text;
begin
  select last_dispatched_at, last_request_id
    into sent_at, request_id
    from private.pitch_upload_dispatch
   where id = 1;
  if sent_at is null or request_id is distinct from 42 then
    raise exception 'dispatch did not record the pg_net id, at=% id=%', sent_at, request_id;
  end if;
  select count(*), max(url), max(body ->> 'event_type'), max(headers ->> 'Authorization')
    into calls, target, event_type, auth_header
    from net.calls;
  if calls <> 1 then
    raise exception 'expected one GitHub call for the burst, got %', calls;
  end if;
  if target <> 'https://api.github.com/repos/wsccbaseball/ws-baseball/dispatches' then
    raise exception 'unexpected dispatch url %', target;
  end if;
  if event_type <> 'pitches-uploaded' then
    raise exception 'unexpected event_type %', event_type;
  end if;
  if auth_header <> 'Bearer test-token-not-real' then
    raise exception 'dispatch token was not sent as a bearer token';
  end if;
  if (select body::text from net.calls) like '%test-token-not-real%' then
    raise exception 'token leaked into the dispatch body';
  end if;
end
$sent$;

-- Second tick in the same quiet window must not call GitHub again.
select private.dispatch_pitch_scoring();

do $once$
declare
  calls int;
begin
  select count(*) into calls from net.calls;
  if calls <> 1 then
    raise exception 'overlapping tick dispatched again (% calls)', calls;
  end if;
end
$once$;

-- No Vault secret: bookmark stays, nothing is sent, nightly cron is the backup.
delete from vault.decrypted_secrets;
update private.pitch_upload_dispatch
   set last_dispatched_at = null
 where id = 1;
select private.dispatch_pitch_scoring();

do $notoken$
declare
  sent_at timestamptz;
  calls int;
begin
  select last_dispatched_at into sent_at from private.pitch_upload_dispatch where id = 1;
  select count(*) into calls from net.calls;
  if sent_at is not null or calls <> 1 then
    raise exception 'missing token must not dispatch, at=% calls=%', sent_at, calls;
  end if;
end
$notoken$;
'''
        result = _psql(script)
        if result.returncode != 0:
            self.fail(result.stderr or result.stdout)


if __name__ == '__main__':
    unittest.main()
