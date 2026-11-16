const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

require('./knowledge-search.js');
const ks = globalThis.WSKnowledgeSearch;

const MIGRATION = path.join(__dirname, 'migrations', '20261116183000_hq_knowledge_search.sql');

test('clean query strips wildcards and caps length', () => {
  assert.equal(ks.cleanQuery('  DeFranco  '), 'DeFranco');
  assert.equal(ks.cleanQuery('%pop_time\\'), 'poptime');
  assert.equal(ks.cleanQuery('x'.repeat(120)).length, 80);
  assert.equal(ks.cleanQuery('   '), '');
});

test('space and hyphen are the same search', () => {
  assert.deepEqual(ks.searchVariants('pop time'), ['pop time', 'pop-time']);
  assert.deepEqual(ks.searchVariants('pop-time'), ['pop-time', 'pop time']);
  assert.deepEqual(ks.searchVariants('DeFranco'), ['DeFranco']);
  assert.deepEqual(ks.searchVariants('long   toss'), ['long   toss', 'long toss', 'long-toss']);
});

test('or filter searches summary, source text, and matching tags', () => {
  const filter = ks.knowledgeOrFilter('DeFranco', ['defranco', 'throwing', 'abca']);
  assert.match(filter, /summary\.ilike\."%DeFranco%"/);
  assert.match(filter, /source_text\.ilike\."%DeFranco%"/);
  assert.match(filter, /tags\.cs\.\{"defranco"\}/);
  assert.doesNotMatch(filter, /throwing/);

  const pop = ks.knowledgeOrFilter('pop time', ['pop-time', 'catching', 'defense']);
  assert.match(pop, /summary\.ilike\."%pop time%"/);
  assert.match(pop, /summary\.ilike\."%pop-time%"/);
  assert.match(pop, /source_text\.ilike\."%pop time%"/);
  assert.match(pop, /tags\.cs\.\{"pop-time"\}/);
  assert.doesNotMatch(pop, /catching/);
});

test('quotes and spaces in tags stay inside PostgREST quotes', () => {
  assert.equal(ks.tagContainsFilter('practice planning'), '{"practice planning"}');
  assert.equal(ks.postgrestQuote('say "hi"'), '"say ""hi"""');
  const filter = ks.knowledgeOrFilter('say "hi"', ['practice planning']);
  assert.match(filter, /summary\.ilike\."%say ""hi""%"/);
  assert.equal(ks.knowledgeOrFilter('   ', ['abca']), '');
  assert.equal(ks.knowledgeOrFilter('%', ['abca']), '');
});

test('tag match is case-insensitive and does not use unrelated tags', () => {
  assert.deepEqual(
    ks.matchingTags(['DeFranco', 'throwing', 'ABCA'], 'abca'),
    ['ABCA']
  );
  assert.deepEqual(
    ks.matchingTags(['throwing', 'throwing-program', 'pitching'], 'throw'),
    ['throwing', 'throwing-program']
  );
});

test('chips keep the common tags and a selected tag outside that list', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push({ tags: ['abca'] });
  for (let i = 0; i < 10; i += 1) rows.push({ tags: ['defranco'] });
  rows.push({ tags: ['rare-tag'] });
  const tallied = ks.tallyTags(rows);
  assert.deepEqual(tallied.map((chip) => chip.tag), ['abca', 'defranco', 'rare-tag']);
  assert.deepEqual(ks.chipTags(tallied, 1, '').map((chip) => chip.tag), ['abca']);
  assert.deepEqual(ks.chipTags(tallied, 1, 'rare-tag').map((chip) => chip.tag), ['abca', 'rare-tag']);
});

test('count label and rpc payload', () => {
  assert.equal(ks.noteCountLabel(null), 'Searching…');
  assert.equal(ks.noteCountLabel(1), '1 note');
  assert.equal(ks.noteCountLabel(58), '58 notes');
  assert.deepEqual(ks.normalizeKnowledgeResult({ total: 2, items: [{ id: 'a' }] }), {
    total: 2,
    items: [{ id: 'a' }],
  });
  assert.deepEqual(ks.normalizeKnowledgeResult('{"total":0,"items":[]}'), { total: 0, items: [] });
  assert.equal(ks.isMissingKnowledgeRpc({ code: 'PGRST202', message: 'Could not find the function' }), true);
  assert.equal(ks.isMissingKnowledgeRpc({ code: '42501', message: 'permission denied for function hq_search_knowledge' }), false);
});

test('migration does not rewrite or delete knowledge rows', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  assert.match(sql, /hq_search_knowledge/);
  assert.match(sql, /extensions\.gin_trgm_ops/);
  assert.match(sql, /security invoker/);
  assert.doesNotMatch(sql, /\b(delete\s+from|drop\s+table|truncate|update\s+public\.hq_knowledge_items)\b/i);
});

function psqlAvailable() {
  try {
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'postgres', '-c', 'select 1'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function psql(db, sql, args) {
  return execFileSync(
    'sudo',
    ['-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args || [], ['-f', '-']),
    { input: sql, encoding: 'utf8' }
  );
}

test('hq_search_knowledge matches text and tags and uses the trigram index', { skip: !psqlAvailable() }, () => {
  const migration = fs.readFileSync(MIGRATION, 'utf8');
  psql('postgres', 'drop database if exists hq_knowledge_search_test;');
  psql('postgres', `
    do $$
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
    $$;
    create database hq_knowledge_search_test;
  `);
  try {
    psql('hq_knowledge_search_test', `
      create table public.hq_knowledge_items (
        id uuid primary key,
        source_url text,
        source_text text,
        summary text,
        tags text[] not null default '{}',
        linked_player_id uuid,
        created_at timestamptz not null default now()
      );
      insert into public.hq_knowledge_items (id, summary, source_text, tags, created_at) values
        ('00000000-0000-0000-0000-000000000001', 'DeFranco warm-up', 'long toss progression', array['defranco','throwing'], '2026-11-01T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000002', 'Arm care only', null, array['defranco'], '2026-11-02T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000003', 'Catcher pop-time reps', 'start on a random signal', array['catching','pop-time'], '2026-10-01T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000004', 'Infield pop time to the bag', 'stopwatch', array['defense'], '2026-10-02T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000005', 'Bullpen day', 'nothing about the search terms here', array['pitching'], '2026-09-01T00:00:00Z'),
        ('00000000-0000-0000-0000-000000000006', 'Literal percent note', '100% effort', array['culture'], '2026-08-01T00:00:00Z');
      alter table public.hq_knowledge_items enable row level security;
      create policy hq_knowledge_items_anon_all
        on public.hq_knowledge_items
        for all
        to anon
        using (true)
        with check (true);
      grant select on table public.hq_knowledge_items to anon;
    `);
    psql('hq_knowledge_search_test', migration);
    const checks = psql('hq_knowledge_search_test', `
      select 'defranco ' || (public.hq_search_knowledge('DeFranco', '', 10, 0))::text;
      select 'pop_time ' || (public.hq_search_knowledge('pop time', '', 10, 0))::text;
      select 'pop_catching ' || (public.hq_search_knowledge('pop time', 'catching', 10, 0))::text;
      select 'long_toss ' || (public.hq_search_knowledge('long toss', '', 10, 0))::text;
      select 'abca ' || (public.hq_search_knowledge('ABCA', '', 10, 0))::text;
      select 'page ' || (public.hq_search_knowledge('', '', 1, 1))::text;
      select 'none ' || (public.hq_search_knowledge('zzzz-nope', '', 10, 0))::text;
      select 'wild ' || (public.hq_search_knowledge('%', '', 10, 0))::text;
      select 'percent ' || (public.hq_search_knowledge('100%', '', 10, 0))::text;
      select 'rows ' || count(*)::text from public.hq_knowledge_items;
    `, ['-At']);
    function payload(name) {
      const line = checks.split('\n').find((row) => row.startsWith(name + ' '));
      assert.ok(line, name + ' missing from:\\n' + checks);
      return JSON.parse(line.slice(name.length + 1));
    }
    const defranco = payload('defranco');
    assert.equal(defranco.total, 2);
    assert.equal(defranco.items[0].id, '00000000-0000-0000-0000-000000000002');
    assert.equal(defranco.items[1].summary, 'DeFranco warm-up');

    const pop = payload('pop_time');
    assert.equal(pop.total, 2);
    assert.deepEqual(pop.items.map((row) => row.id).sort(), [
      '00000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000004',
    ]);

    const popCatching = payload('pop_catching');
    assert.equal(popCatching.total, 1);
    assert.equal(popCatching.items[0].id, '00000000-0000-0000-0000-000000000003');

    const longToss = payload('long_toss');
    assert.equal(longToss.total, 1);
    assert.equal(longToss.items[0].id, '00000000-0000-0000-0000-000000000001');

    assert.equal(payload('abca').total, 0);
    const page = payload('page');
    assert.equal(page.total, 6);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, '00000000-0000-0000-0000-000000000001');
    assert.equal(payload('none').total, 0);
    assert.deepEqual(payload('none').items, []);
    assert.equal(payload('wild').total, 6);
    assert.equal(payload('percent').total, 1);
    assert.ok(checks.split('\n').includes('rows 6'));

    const plan = psql('hq_knowledge_search_test', `
      set enable_seqscan = off;
      explain select id
      from public.hq_knowledge_items k
      where public.hq_knowledge_search_blob(k.summary, k.source_text, k.tags) ilike '%defranco%';
    `, ['-At']);
    assert.match(plan, /hq_knowledge_items_search_trgm/);

    const anon = psql('hq_knowledge_search_test', `
      set role anon;
      select public.hq_search_knowledge('DeFranco')::text;
      reset role;
    `, ['-At']);
    assert.match(anon, /"total": 2/);
  } finally {
    psql('postgres', 'drop database if exists hq_knowledge_search_test;');
  }
});
