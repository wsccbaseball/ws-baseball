const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const packet = require('./scout-packet');

function hitter(num, name, extra) {
  return Object.assign({
    num: String(num),
    name: name,
    avg: '.306',
    ab: 180,
    bb: 30,
    hbp: 4,
    sf: 2,
    sh: 2,
    hr: 3,
    k: 42,
    sb: 27,
    obp: '.427',
    slg: '.433'
  }, extra || {});
}

test('identical stat-sheet rows collapse to one hitter', function () {
  var strain = hitter(1, 'Strain, Holden');
  var vaughn = hitter(10, 'Vaughn, Conner', { ab: 171, bb: 24, sh: 2, avg: '.287' });
  var rows = [strain, Object.assign({}, strain), vaughn, Object.assign({}, vaughn)];
  var out = packet.dedupeHitters(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Strain, Holden');
  assert.equal(out[1].name, 'Vaughn, Conner');
  assert.equal(out[0].ab, 180);
  var teamSh = out.reduce(function (n, s) { return n + (s.sh || 0); }, 0);
  assert.equal(teamSh, 4);
});

test('a shorter second line does not replace the season line', function () {
  var season = hitter(1, 'Strain, Holden', { ab: 180, bb: 30 });
  var split = hitter(1, 'Holden Strain', { ab: 40, bb: 4, avg: '.250', sh: 0 });
  assert.equal(packet.keyOf(season.name), packet.keyOf(split.name));
  var out = packet.dedupeHitters([season, split]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ab, 180);
  assert.equal(out[0].avg, '.306');
});

test('a later line with at least as many PA replaces the earlier one', function () {
  var stale = hitter(14, 'Williamson, Jordan', { ab: 100, bb: 10, avg: '.300' });
  var fresh = hitter(14, 'Williamson, Jordan', { ab: 162, bb: 36, avg: '.346' });
  var out = packet.dedupeHitters([stale, fresh]);
  assert.equal(out.length, 1);
  assert.equal(out[0].avg, '.346');
  assert.equal(out[0].ab, 162);
});

test('different players stay, including the same last name on another jersey', function () {
  var out = packet.dedupeHitters([
    hitter(1, 'Strain, Holden'),
    hitter(21, 'Strain, Hayden', { ab: 10, bb: 1 }),
    hitter(34, 'Hall, Jace', { ab: 0, bb: 1, hbp: 0, sf: 0, sh: 0 })
  ]);
  assert.deepEqual(out.map(function (s) { return s.num; }), ['1', '21', '34']);
});

test('plate appearances count walks and sacrifices, not just at-bats', function () {
  assert.equal(packet.hitterPA({ ab: 180, bb: 30, hbp: 4, sf: 2, sh: 4 }), 220);
});

test('both packet pages dedupe hitters and let the staff table break', function () {
  ['tools/scouting-ingest.html', 'scout/index.html'].forEach(function (file) {
    var html = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(html, /src="\.\.\/scout-packet\.js"/);
    assert.match(html, /function keyOf\(name\)\{return ScoutPacket\.keyOf\(name\);\}/);
    assert.match(html, /t\.hit=ScoutPacket\.dedupeHitters\(t\.hit\)/);
    var tableRules = html.match(/table\.staff\{[^}]+\}/g) || [];
    assert.ok(tableRules.length >= 1, file);
    tableRules.forEach(function (rule) {
      assert.equal(/break-inside\s*:\s*avoid/.test(rule), false, file + ' ' + rule);
      assert.equal(/page-break-inside\s*:\s*avoid/.test(rule), false, file + ' ' + rule);
    });
    assert.match(html, /table\.staff tr\{[^}]*break-inside:\s*avoid/);
  });
});
