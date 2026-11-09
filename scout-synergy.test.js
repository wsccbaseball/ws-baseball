const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const packet = require('./scout-packet');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const FIX = path.join(__dirname, 'scout', 'fixtures');
const TEAMS = ['Murray State College', 'Walters State Community College'];

function read(name) { return fs.readFileSync(path.join(FIX, name), 'utf8'); }

async function extractRows(file) {
  var data = new Uint8Array(fs.readFileSync(file));
  var pdf = await pdfjsLib.getDocument({ data: data, disableWorker: true, isEvalSupported: false }).promise;
  var rows = [];
  for (var p = 1; p <= pdf.numPages; p++) {
    var pg = await pdf.getPage(p);
    var content = await pg.getTextContent();
    var items = content.items.map(function (it) {
      return { x: it.transform[4], y: it.transform[5], w: it.width || 0, str: it.str };
    });
    rows.push(packet.buildViews(items).rowText);
  }
  return rows.join('\n');
}

function rosterFile(text, extra) {
  return Object.assign({ type: 'roster', rowsText: text, name: 'roster', rosterTeam: '', rosterLock: '' }, extra || {});
}

// The page copies basic.n onto the mix, then dangerLine keeps pitches with
// SLG >= .450 that pass this gate. 'named' is a real damage read, 'thin' is
// the subsample fallback, 'spread' is no pitch at SLG >= .450.
function dangerBranch(mix) {
  var raw = mix.filter(function (m) { return m.slg != null && m.slg >= 0.450; });
  if (!raw.length) return 'spread';
  var dmg = raw.filter(packet.mixDangerEligible);
  if (!dmg.length) return 'thin';
  return 'named:' + dmg.map(function (m) { return m.p; }).join(',');
}

function mixOf(basic, pitch) {
  return {
    p: pitch,
    usage: 100,
    n: basic.n != null ? basic.n : null,
    avg: basic.avg != null ? parseFloat(basic.avg) : null,
    obp: basic.obp != null ? parseFloat(basic.obp) : null,
    slg: basic.slg != null ? parseFloat(basic.slg) : null
  };
}

var taylorRows;

test.before(async function () {
  taylorRows = await extractRows(path.join(FIX, 'taylor-brady-2026-vs-fastballs.pdf'));
});

test('Taylor vs fastballs uses AB as the sample, not ROE, and is danger-eligible', function () {
  assert.match(taylorRows, /ROE BB IBB K HBP SH SF AVG OBP SLG OPS/);
  assert.match(taylorRows, /Events G PA \(BF\) AB BIP H 1B 2B 3B HR RBI/);
  assert.match(taylorRows, /0 24 0 17 5 0 2 \.380 \.549 \.859 1\.408/);
  var r = packet.parseSynergy(taylorRows);
  assert.equal(r.role, 'hitter');
  assert.equal(r.name, 'Taylor, Brady');
  assert.equal(r.team, 'Murray State College');
  assert.equal(r.sub, 'vsFB');
  assert.equal(r.basic.avg, '.380');
  assert.equal(r.basic.obp, '.549');
  assert.equal(r.basic.slg, '.859');
  assert.equal(r.basic.ops, '1.408');
  assert.equal(r.basic.bb, 24);
  assert.equal(r.basic.k, 17);
  assert.equal(r.basic.hr, 8);
  assert.equal(r.basic.xbh, 18);
  // PA (BF) is 102, AB is 71, ROE is 0, Events is 396. SLG's sample is AB.
  assert.equal(r.basic.n, 71);
  assert.notEqual(r.basic.n, 0);
  assert.equal(r.mix.Fastball.usage, 100);
  assert.equal(r.mix.Fastball.whiff, 31);
  assert.equal(r.bip.gb, 25);
  assert.equal(dangerBranch([mixOf(r.basic, 'Fastball')]), 'named:Fastball');
  // The old read of this file stored ROE and the gate rejected the pitch.
  assert.equal(dangerBranch([mixOf({ n: 0, avg: '.380', obp: '.549', slg: '.859' }, 'Fastball')]), 'thin');
});

test('two-row Synergy keeps BB and K, and a fat ROE does not clear a tiny AB', function () {
  // Shape of a Beene-style vs-fastballs file: ROE is 4, the slash is real.
  var large = [
    'Hitter: Beene, Rayner - Murray State College, 2026',
    'Pitch Type / Velocity: Fastball',
    'Events G PA (BF) AB BIP H 1B 2B 3B HR RBI',
    '300 40 90 70 50 22 8 6 0 8 18',
    'ROE BB IBB K HBP SH SF AVG OBP SLG OPS',
    '4 12 0 15 2 0 1 .314 .420 .571 .991'
  ].join('\n');
  var big = packet.parseSynergy(large);
  assert.equal(big.basic.n, 70);
  assert.notEqual(big.basic.n, 4);
  assert.equal(big.basic.bb, 12);
  assert.equal(big.basic.k, 15);
  assert.equal(big.sub, 'vsFB');
  assert.equal(dangerBranch([mixOf(big.basic, 'Fastball')]), 'named:Fastball');

  // ROE 9 would pass n>=8. AB 4 must not. PA 14 must not replace AB either.
  var tiny = [
    'Hitter: Sample, Sam - Murray State College, 2026',
    'Pitch Type / Velocity: Slider',
    'Events G PA (BF) AB BIP H 1B 2B 3B HR RBI',
    '30 4 14 4 4 2 1 1 0 0 2',
    'ROE BB IBB K HBP SH SF AVG OBP SLG OPS',
    '9 6 0 2 1 0 1 .500 .700 1.000 1.700'
  ].join('\n');
  var small = packet.parseSynergy(tiny);
  assert.equal(small.basic.n, 4);
  assert.notEqual(small.basic.n, 9);
  assert.notEqual(small.basic.n, 14);
  assert.equal(small.sub, 'vsSL');
  assert.equal(dangerBranch([mixOf(small.basic, 'Slider')]), 'thin');

  var noDamage = packet.parseSynergy([
    'Hitter: Poage, Jackson - Murray State College, 2026',
    'Pitch Type / Velocity: Fastball',
    'Events G PA (BF) AB BIP H 1B 2B 3B HR RBI',
    '80 20 40 36 30 10 8 2 0 0 4',
    'ROE BB IBB K HBP SH SF AVG OBP SLG OPS',
    '0 2 0 8 1 0 1 .278 .320 .333 .653'
  ].join('\n'));
  assert.equal(noDamage.basic.n, 36);
  assert.equal(dangerBranch([mixOf(noDamage.basic, 'Fastball')]), 'spread');
});

test('older Synergy layouts still take the slash-line sample and the out counts', function () {
  var headed = [
    'Hitter: Taylor, Brady - Murray State College, 2025',
    'Pitch Type / Velocity: Fastball',
    'AB BB IBB K HBP SH SF AVG OBP SLG OPS',
    '71 24 0 17 5 0 2 .380 .549 .859 1.408'
  ].join('\n');
  var old = packet.parseSynergy(headed);
  assert.equal(old.basic.n, 71);
  assert.equal(old.basic.bb, 24);
  assert.equal(old.basic.k, 17);
  assert.equal(dangerBranch([mixOf(old.basic, 'Fastball')]), 'named:Fastball');

  var bare = packet.parseSynergy([
    'Hitter: Sample, Sam - Murray State College, 2024',
    'Pitch Type / Velocity: Curveball',
    '4 1 0 2 .250 .400 .750 1.150'
  ].join('\n'));
  assert.equal(bare.basic.n, 4);
  assert.equal(bare.basic.bb, 1);
  assert.equal(bare.basic.k, 2);
  assert.equal(dangerBranch([mixOf(bare.basic, 'Curveball')]), 'thin');

  assert.equal(packet.mixDangerEligible({ n: 8, slg: 0.450, usage: null }), true);
  assert.equal(packet.mixDangerEligible({ n: 7, slg: 0.900, usage: 80 }), false);
  assert.equal(packet.mixDangerEligible({ slg: 0.800, usage: 40 }), true);
  assert.equal(packet.mixDangerEligible({ slg: 0.800, usage: null }), false);

  // A counting row beside an old slash line does not replace the leading sample.
  // XBH still comes off indexes 7/8/9 of the first 11-integer line.
  var split = [
    'Hitter: Sample, Sam - Murray State College, 2024',
    'Pitch Type / Velocity: Changeup',
    'PA G AB BIP H 1B 2B 3B HR BB K',
    '40 10 30 20 8 4 2 0 2 6 9',
    'AB BB HBP K AVG OBP SLG OPS',
    '30 6 1 9 .267 .400 .500 .900'
  ].join('\n');
  var both = packet.parseSynergy(split);
  assert.equal(both.basic.n, 30);
  assert.equal(both.basic.bb, 6);
  assert.equal(both.basic.k, 9);
  assert.equal(both.basic.hr, 6);
  assert.equal(both.basic.xbh, 8);
  assert.equal(both.sub, 'vsCH');
  assert.equal(dangerBranch([mixOf(both.basic, 'Changeup')]), 'named:Changeup');

  var paOnly = [
    'Hitter: Sample, Sam - Murray State College, 2026',
    'Pitch Type / Velocity: Fastball',
    'Events G PA BIP H X 1B 2B 3B HR RBI',
    '80 20 40 30 15 10 5 4 1 2 8',
    'ROE BB IBB K HBP SH SF AVG OBP SLG OPS',
    '1 8 0 6 1 0 0 .400 .500 .600 1.100'
  ].join('\n');
  assert.equal(packet.parseSynergy(paOnly).basic.n, 40);

  var clipped = [
    'Hitter: Taylor, Brady - Murray State College, 2026',
    'Pitch Type / Velocity: Fastball',
    'Events G',
    '396 46 102 71 56 27 9 10 0 8 24',
    'ROE BB IBB K HBP SH SF AVG OBP SLG OPS',
    '0 24 0 17 5 0 2 .380 .549 .859 1.408'
  ].join('\n');
  assert.equal(packet.parseSynergy(clipped).basic.n, 71);
});

test('a Synergy pitcher missing from the pitching sheet gets this team’s roster number only', function () {
  var murrayCsv = read('murray-2026-official-roster.csv');
  var walters = read('SYNTHETIC-walters-overlap-roster.csv') + '\n45,Casey Bennett,R/R,Walters State\n';
  var files = [
    rosterFile(murrayCsv, { name: 'murray-roster.csv' }),
    rosterFile(walters, { name: 'walters-roster.csv' })
  ];
  var murray = packet.handsForTeam(files, 'Murray State College', TEAMS);
  var waltersHands = packet.handsForTeam(files, 'Walters State Community College', TEAMS);
  var graham = murray.players.filter(function (p) { return p.num === '45'; })[0];
  assert.equal(graham.name, 'Remington Graham');
  assert.equal(graham.bats, null);
  assert.equal(graham.throws, null);
  assert.equal(waltersHands.byNum['45'].name, 'Casey Bennett');
  assert.equal(waltersHands.byNum['45'].throws, 'R');

  assert.equal(packet.pitcherJersey(undefined, murray.players, 'Graham, Remington'), '45');
  assert.equal(packet.pitcherJersey('', murray.players, 'Remington Graham'), '45');
  assert.equal(packet.pitcherJersey('12', murray.players, 'Graham, Remington'), '12');
  assert.equal(packet.pitcherJersey(null, waltersHands.players, 'Graham, Remington'), '?');
  assert.equal(packet.pitcherJersey(null, [], 'Graham, Remington'), '?');
  assert.equal(packet.handFor(murray, '45', 'Remington Graham').bats, null);
  assert.equal(packet.handFor(murray, '45', 'Remington Graham').throws, null);
  assert.notEqual(packet.handFor(murray, '45', 'Graham, Remington').throws, 'R');

  assert.equal(packet.pitcherJersey(null, [
    { num: '45', name: 'Remington Graham' },
    { num: '4', name: 'Ryan Graham' }
  ], 'Graham, Remington'), '?');
  assert.equal(packet.pitcherJersey(null, [
    { num: '45', name: 'Remington Graham' },
    { num: '45', name: 'Graham, Remington' }
  ], 'Graham, Remington'), '45');

  // Beene is on the roster and can have a pitching-sheet line. A number lookup
  // does not create his card; the book still walks Synergy pitcher files only.
  assert.equal(packet.rosterNumberFor(murray.players, 'Beene, Rayner'), '22');
});

test('both packet pages share the sample gate and the roster jersey fallback', function () {
  var scout = fs.readFileSync(path.join(__dirname, 'scout/index.html'), 'utf8');
  var ingest = fs.readFileSync(path.join(__dirname, 'tools/scouting-ingest.html'), 'utf8');
  assert.equal(scout, ingest);
  [scout].forEach(function (html) {
    assert.match(html, /function parseSynergy\(rowsText\)\{return ScoutPacket\.parseSynergy\(rowsText\);\}/);
    assert.match(html, /function mixDangerEligible\(m\)\{return ScoutPacket\.mixDangerEligible\(m\);\}/);
    assert.match(html, /n:b\.n!=null\?b\.n:null/);
    assert.match(html, /var dmg=raw\.filter\(mixDangerEligible\);/);
    assert.match(html, /Damage reads are thin in the per-pitch files/);
    assert.match(html, /Spreads contact — no single damage pitch/);
    var pit = html.slice(html.indexOf('function assemblePitchers'), html.indexOf('function ss('));
    assert.match(pit, /synergyByPlayer\('synergyPit'\)/);
    assert.match(pit, /rosterPlayers=\(handsBundle\(team\.team\)\.players\)\|\|\[\]/);
    assert.match(pit, /handOn\(team\.team, cs\.num, cs\.name\|\|nm\)/);
    assert.match(pit, /jersey:ScoutPacket\.pitcherJersey\(cs\.num, rosterPlayers, cs\.name\|\|nm\)/);
    assert.equal(/team\.pit\.forEach/.test(pit), false);
  });
});
