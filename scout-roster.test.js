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

function hand(files, team, num, statName) {
  return packet.handFor(packet.handsForTeam(files, team, TEAMS), num, statName);
}

var waltersRosterText;
var murrayCsv;

test.before(async function () {
  waltersRosterText = await extractRows(path.join(FIX, 'walters-2025-26-official-roster.pdf'));
  murrayCsv = read('murray-2026-official-roster.csv');
});

test('official Walters roster keeps its own hands and Murray roster keeps blanks', function () {
  assert.equal(packet.classifyUpload(waltersRosterText).type, 'roster');
  assert.equal(packet.classifyUpload(murrayCsv).type, 'roster');
  var walters = packet.parseRosterSheet(waltersRosterText);
  var murray = packet.parseRosterSheet(murrayCsv);
  assert.match(walters.teamHint, /Walters State/);
  assert.equal(murray.teamHint, 'Murray State College');
  assert.equal(murray.players.length, 40);
  assert.equal(murray.players.filter(function (p) { return p.bats || p.throws; }).length, 0);
  var hitch = murray.players.filter(function (p) { return p.num === '1'; })[0];
  assert.equal(hitch.name, 'Braden Hitchcock');
  assert.equal(hitch.bats, null);
  var eli = murray.players.filter(function (p) { return p.num === '5'; })[0];
  assert.equal(eli.name, 'Eli Ramirez');
  assert.equal(eli.bats, null);

  function waltersPlayer(num) {
    return walters.players.filter(function (p) { return p.num === String(num); })[0];
  }
  assert.equal(waltersPlayer(1).name, 'Brady Dalton');
  assert.equal(waltersPlayer(1).bats, 'R');
  assert.equal(waltersPlayer(1).throws, 'R');
  assert.equal(waltersPlayer(5).name, 'Kole Fenton');
  assert.equal(waltersPlayer(5).bats, 'R');
  assert.equal(waltersPlayer(5).throws, 'R');
  assert.equal(waltersPlayer(14).name, 'Major Osbolt');
  assert.equal(waltersPlayer(14).bats, 'L');
  assert.equal(waltersPlayer(14).throws, 'R');
  assert.equal(waltersPlayer(17).name, 'Tim Tyler');
  assert.equal(waltersPlayer(17).bats, 'L');
  assert.equal(waltersPlayer(17).throws, 'L');
  assert.equal(waltersPlayer(9).bats, 'L');
  assert.equal(waltersPlayer(9).throws, 'L');

  var files = [
    rosterFile(waltersRosterText, { name: 'walters-roster.pdf' }),
    rosterFile(murrayCsv, { name: 'murray-roster.csv' })
  ];
  var reversed = files.slice().reverse();
  ['5', '14', '17', '1'].forEach(function (num) {
    var a = hand(files, 'Walters State Community College', num, '');
    var b = hand(reversed, 'Walters State Community College', num, '');
    assert.equal(a.bats, b.bats);
    assert.equal(a.throws, b.throws);
    assert.equal(a.reason, 'ok');
    assert.equal(hand(files, 'Murray State College', num, '').bats, null);
    assert.equal(hand(reversed, 'Murray State College', num, '').bats, null);
  });
  assert.equal(hand(files, 'Walters State Community College', '5', 'Kole Fenton').bats, 'R');
  assert.equal(hand(files, 'Murray State College', '5', 'Eli Ramirez').reason, 'unknown');
  assert.equal(hand(files, 'Murray State College', '5', 'Eli Ramirez').bats, null);
  // Walters #5 must not lend R/R to Murray's Eli, in either upload order.
  assert.notEqual(hand(files, 'Murray State College', '5', 'Eli Ramirez').bats, 'R');
  assert.notEqual(hand(reversed, 'Murray State College', '5', 'Kole Fenton').throws, 'R');
});

test('synthetic overlapping jerseys stay on their own team in either order', function () {
  var walters = read('SYNTHETIC-walters-overlap-roster.csv');
  var murray = read('SYNTHETIC-murray-overlap-roster.csv');
  assert.match(walters, /SYNTHETIC|L\/L/);
  assert.match(murray, /Murray State College/);
  var files = [
    rosterFile(walters, { name: 'SYNTHETIC-walters-overlap-roster.csv' }),
    rosterFile(murray, { name: 'SYNTHETIC-murray-overlap-roster.csv' })
  ];
  var flipped = files.slice().reverse();
  [files, flipped].forEach(function (set) {
    assert.deepEqual(hand(set, 'Walters State Community College', '5', 'Kole Fenton'), {
      bats: 'L', throws: 'L', reason: 'ok', name: 'Kole Fenton'
    });
    assert.deepEqual(hand(set, 'Murray State College', '5', 'Eli Ramirez'), {
      bats: 'R', throws: 'R', reason: 'ok', name: 'Eli Ramirez'
    });
    assert.equal(hand(set, 'Walters State Community College', '22', 'Holden Pantier').bats, 'S');
    assert.equal(hand(set, 'Murray State College', '22', 'Rayner Beene').bats, 'L');
    assert.equal(hand(set, 'Murray State College', '22', 'Rayner Beene').throws, 'R');
    assert.equal(hand(set, 'Walters State Community College', '30', 'Drew Blalock').bats, 'R');
    assert.equal(hand(set, 'Murray State College', '30', 'Brady LaViolette').reason, 'unknown');
    assert.equal(hand(set, 'Murray State College', '30', 'Brady LaViolette').bats, null);
  });
  // Two-way: the same Walters jersey serves the hitter book and the pitcher book.
  var asHitter = hand(files, 'Walters State Community College', '30', 'Drew Blalock');
  var asPitcher = hand(files, 'Walters State Community College', '30', 'Blalock, Drew');
  assert.equal(asHitter.bats, 'R');
  assert.equal(asPitcher.throws, 'R');
  assert.equal(packet.keyOf('Drew Blalock'), packet.keyOf('Blalock, Drew'));
});

test('unknown, conflicting, and mismatched roster hands are not borrowed', function () {
  var loose = 'SYNTHETIC roster with no school name\n5 Pat Example OF R/R\n';
  var files = [
    rosterFile(read('SYNTHETIC-walters-overlap-roster.csv'), { name: 'walters.csv' }),
    rosterFile(read('SYNTHETIC-murray-overlap-roster.csv'), { name: 'murray.csv' }),
    rosterFile(loose, { name: 'SYNTHETIC-unassigned.txt' })
  ];
  assert.equal(packet.effectiveRosterTeam(files[2], TEAMS).status, 'unassigned');
  assert.equal(packet.effectiveRosterTeam(files[2], TEAMS).team, null);
  assert.equal(hand(files, 'Walters State Community College', '5', 'Kole Fenton').bats, 'L');
  assert.equal(hand(files, 'Murray State College', '5', 'Eli Ramirez').bats, 'R');
  var notes = packet.rosterNotices(files, TEAMS);
  assert.ok(notes.some(function (n) { return n.level === 'err' && /not tied to one team/.test(n.text); }));

  var clash = [
    rosterFile('Walters State Baseball Roster\n5 Kole Fenton OF L/L\n', { name: 'a.csv' }),
    rosterFile('Walters State Baseball Roster\n5 Kole Fenton OF R/R\n', { name: 'b.csv' })
  ];
  var fought = hand(clash, 'Walters State Community College', '5', 'Kole Fenton');
  assert.equal(fought.bats, null);
  assert.equal(fought.reason, 'conflict');
  assert.equal(hand(clash, 'Murray State College', '5', 'Eli Ramirez').reason, 'missing');
  assert.ok(packet.rosterNotices(clash, TEAMS).some(function (n) { return /two different B\/T/.test(n.text); }));

  var wrongName = hand(files, 'Walters State Community College', '5', 'Eli Ramirez');
  assert.equal(wrongName.reason, 'name');
  assert.equal(wrongName.bats, null);

  var bothMurrays = ['Murray State College', 'Murray State University'];
  var college = rosterFile('Murray State College Baseball Roster\n5 Eli Ramirez OF R/R\n', { name: 'college.csv' });
  assert.equal(packet.effectiveRosterTeam(college, bothMurrays).status, 'ambiguous');
  assert.equal(packet.handsForTeam([college], 'Murray State College', bothMurrays).players.length, 0);
  assert.equal(packet.handFor(packet.handsForTeam([college], 'Murray State University', bothMurrays), '5', 'Eli Ramirez').bats, null);
});

test('removing a roster or its stat team drops only that team’s hands', function () {
  var walters = rosterFile(read('SYNTHETIC-walters-overlap-roster.csv'), { name: 'walters.csv' });
  var murray = rosterFile(read('SYNTHETIC-murray-overlap-roster.csv'), { name: 'murray.csv' });
  assert.equal(hand([murray], 'Murray State College', '5', 'Eli Ramirez').bats, 'R');
  assert.equal(hand([murray], 'Walters State Community College', '5', 'Kole Fenton').reason, 'missing');
  var locked = rosterFile(read('SYNTHETIC-walters-overlap-roster.csv'), {
    name: 'walters.csv',
    rosterLock: 'user',
    rosterTeam: 'Walters State Community College'
  });
  assert.equal(packet.effectiveRosterTeam(locked, TEAMS).status, 'user');
  assert.equal(packet.effectiveRosterTeam(locked, ['Murray State College']).status, 'missing');
  assert.equal(packet.effectiveRosterTeam(locked, ['Murray State College']).team, null);
  assert.equal(hand([locked], 'Murray State College', '5', 'Eli Ramirez').reason, 'missing');
  // Restored session keeps the coach's assignment and still will not lend it.
  var restored = {
    type: 'roster',
    rowsText: locked.rowsText,
    rosterTeam: 'Walters State Community College',
    rosterLock: 'user'
  };
  assert.equal(packet.effectiveRosterTeam(restored, TEAMS).team, 'Walters State Community College');
  assert.equal(packet.handFor(packet.handsForTeam([restored], 'Murray State College', TEAMS), '5', 'Eli Ramirez').bats, null);
  assert.equal(packet.handFor(packet.handsForTeam([restored], 'Walters State Community College', TEAMS), '5', 'Kole Fenton').bats, 'L');
});

test('both packet pages scope hands by team and do not gate the game plan on B/T', function () {
  ['scout/index.html', 'tools/scouting-ingest.html'].forEach(function (file) {
    var html = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.equal(html.indexOf('rosterBT()'), -1, file);
    assert.match(html, /handsForTeam\(rosterFiles\(\), teamName, statTeamNames\(\)\)/);
    assert.match(html, /function ourBatsMap\(us\)/);
    assert.match(html, /rosterTeam:f\.rosterTeam\|\|''/);
    assert.match(html, /rosterLock:f\.rosterLock\|\|''/);
    assert.match(html, /if\(!sessionReady\) return;/);
    assert.equal(/your roster with B\/T/.test(html), false, file);
    assert.match(html, /needs:\['synergyPit','stats'\]/);
    assert.match(html, /statTeams\(\)\.length<2/);
    var gp = html.slice(html.indexOf("id:'gameplan'"), html.indexOf("id:'matrix'"));
    assert.equal(/roster/.test(gp), false, file);
  });
  assert.equal(
    fs.readFileSync(path.join(__dirname, 'scout/index.html'), 'utf8'),
    fs.readFileSync(path.join(__dirname, 'tools/scouting-ingest.html'), 'utf8')
  );
});
