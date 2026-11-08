const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const packet = require('./scout-packet');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const FIX = path.join(__dirname, 'scout', 'fixtures');
const MURRAY_PDF = path.join(FIX, 'murray-2026-official-cumulative.pdf');
const WALTERS_PDF = path.join(FIX, 'walters-2025-26-official-cumulative.pdf');
const ROSTER_CSV = path.join(FIX, 'murray-2026-official-roster.csv');
const SAMPLE = path.join(FIX, 'parsed-2026-sample.json');

function legacyViews(items) {
  var s = items.slice().sort(function (a, b) { return b.y - a.y; });
  var lines = [];
  var cur = null;
  s.forEach(function (it) {
    if (!cur || Math.abs(it.y - cur.y) > 3) {
      cur = { y: it.y, items: [it] };
      lines.push(cur);
    } else cur.items.push(it);
  });
  return lines.map(function (l) {
    return l.items.slice().sort(function (a, b) { return a.x - b.x; }).map(function (i) { return i.str; }).join(' ').replace(/[ \t]+/g, ' ').trim();
  }).filter(function (t) { return t.length; }).join('\n');
}

async function extractPdf(file) {
  var data = new Uint8Array(fs.readFileSync(file));
  var pdf = await pdfjsLib.getDocument({ data: data, disableWorker: true, isEvalSupported: false }).promise;
  var rows = [];
  var legacy = [];
  for (var p = 1; p <= pdf.numPages; p++) {
    var pg = await pdf.getPage(p);
    var content = await pg.getTextContent();
    var items = content.items.map(function (it) {
      return { x: it.transform[4], y: it.transform[5], w: it.width || 0, str: it.str };
    });
    rows.push(packet.buildViews(items).rowText);
    legacy.push(legacyViews(items));
  }
  return { rows: rows.join('\n'), legacy: legacy.join('\n'), pages: pdf.numPages };
}

function byNum(rows, num) {
  var found = rows.filter(function (r) { return String(r.num) === String(num); });
  assert.equal(found.length, 1, 'jersey ' + num + ' count ' + found.length);
  return found[0];
}

function pick(row, keys) {
  var out = {};
  keys.forEach(function (k) { out[k] = row[k]; });
  return out;
}

var HIT_KEYS = ['num', 'name', 'avg', 'ab', 'h', 'db', 'hr', 'slg', 'bb', 'hbp', 'k', 'gdp', 'obp', 'sf', 'sh', 'sb'];
var PIT_KEYS = ['num', 'name', 'era', 'w', 'l', 'app', 'gs', 'sv', 'ip', 'k', 'bb', 'hr', 'baa', 'wp', 'hbp'];

function publicPlayer(row, keys) {
  var out = pick(row, keys);
  if (row.gp != null) out.gp = row.gp;
  if (row.gs != null) out.gs = row.gs;
  return out;
}

function publicSheet(parsed) {
  return {
    team: parsed.team,
    season: parsed.season,
    asOf: parsed.asOf,
    record: parsed.record,
    confRecord: parsed.confRecord,
    skipped: parsed.skipped,
    hitters: parsed.hit.map(function (r) { return publicPlayer(r, HIT_KEYS); }),
    pitchers: parsed.pit.map(function (r) { return publicPlayer(r, PIT_KEYS); }),
    catchers: parsed.cat.map(function (r) { return { num: r.num, name: r.name, sba: r.sba, csb: r.csb }; }),
    battingTotals: parsed.totH,
    pitchingTotals: parsed.totP
  };
}

function rosterIndex(csvText) {
  var map = {};
  csvText.split('\n').slice(1).forEach(function (ln) {
    if (!ln.trim()) return;
    var cols = ln.split(',');
    var num = cols[0].trim();
    var name = cols[1].replace(/\s+/g, ' ').trim();
    var bits = name.split(' ');
    map[num] = {
      last: bits[bits.length - 1].toLowerCase(),
      first: bits.slice(0, -1).join(' ').toLowerCase(),
      batsThrows: (cols[3] || '').trim()
    };
  });
  return map;
}

function statName(name) {
  if (name.indexOf(',') >= 0) {
    var p = name.split(',');
    return { last: p[0].trim().toLowerCase(), first: p[1].trim().toLowerCase() };
  }
  var t = name.split(/\s+/);
  return { last: t[t.length - 1].toLowerCase(), first: t.slice(0, -1).join(' ').toLowerCase() };
}

var extracted;

test.before(async function () {
  extracted = {
    murray: await extractPdf(MURRAY_PDF),
    walters: await extractPdf(WALTERS_PDF)
  };
});

test('PDF.js extraction of the official Murray and Walters cumulatives', function () {
  assert.equal(extracted.murray.pages, 2);
  assert.equal(extracted.walters.pages, 2);
  assert.equal(packet.classifyUpload(extracted.murray.rows).type, 'stats');
  assert.equal(packet.classifyUpload(extracted.walters.rows).type, 'stats');
  // Presto row grouping must stay the 3px join. The raised-ERA repair is a no-op here.
  assert.equal(extracted.walters.rows, extracted.walters.legacy);
  assert.match(extracted.murray.rows, /18 Gorman, Brae 162\.0 0-1 /);
  assert.equal(extracted.murray.rows.split('\n').some(function (ln) { return ln === '162.0'; }), false);
});

test('Murray State College Sidearm cumulative, not Murray State University', function () {
  var sheet = packet.parseStatSheet(extracted.murray.rows);
  assert.equal(sheet.team, 'Murray State College');
  assert.equal(/university/i.test(sheet.team), false);
  assert.equal(sheet.season, '2026');
  assert.equal(sheet.asOf, 'May 27, 2026');
  assert.equal(sheet.record, '43-13');
  assert.equal(sheet.confRecord, '19-5');
  assert.equal(sheet.skipped, 0);
  assert.equal(sheet.hit.length, 16);
  assert.equal(sheet.pit.length, 18);
  assert.equal(sheet.hit.length + sheet.pit.length, 34);

  var distinct = {};
  sheet.hit.concat(sheet.pit).forEach(function (r) { distinct[r.num + '|' + r.name] = 1; });
  assert.equal(Object.keys(distinct).length, 32);

  var beene = byNum(sheet.hit, 22);
  assert.deepEqual(pick(beene, HIT_KEYS.concat(['gp', 'gs'])), {
    num: '22', name: 'Beene, Rayner', avg: '.392', ab: 194, h: 76, db: 20, hr: 14,
    slg: '.763', bb: 25, hbp: 8, k: 48, gdp: 0, obp: '.474', sf: 3, sh: 0, sb: 12, gp: 53, gs: 53
  });
  var ramirez = byNum(sheet.hit, 5);
  assert.equal(ramirez.gp, 55);
  assert.equal(ramirez.gs, 53);
  assert.equal(ramirez.ab, 121);
  assert.equal(byNum(sheet.hit, 6).hr, 20);
  assert.equal(byNum(sheet.hit, 20).bb, 55);
  assert.equal(byNum(sheet.hit, 8).sb, 30);
  assert.equal(byNum(sheet.hit, 3).ab, 8);
  assert.equal(byNum(sheet.hit, 42).ab, 1);
  assert.equal(sheet.hit.some(function (h) { return h.num === '45' || /Graham/.test(h.name); }), false);

  var dome = byNum(sheet.pit, 34);
  assert.deepEqual(pick(dome, PIT_KEYS), {
    num: '34', name: 'Dome, Tayte', era: '4.87', w: 9, l: 4, app: 16, gs: 15, sv: 1,
    ip: '77.2', k: 87, bb: 44, hr: 5, baa: '.256', wp: 2, hbp: 11
  });
  var gorman = byNum(sheet.pit, 18);
  assert.equal(gorman.era, '162.0');
  assert.equal(gorman.w, 0);
  assert.equal(gorman.l, 1);
  assert.equal(gorman.ip, '0.1');
  assert.equal(gorman.k, 1);
  assert.equal(gorman.bb, 3);
  assert.equal(gorman.hbp, 1);
  assert.equal(gorman.baa, '.800');
  assert.equal(byNum(sheet.pit, 36).ip, '0.1');
  assert.equal(byNum(sheet.pit, 5).ip, '53.1');
  assert.equal(byNum(sheet.pit, 5).k, 87);
  assert.equal(byNum(sheet.hit, 22).num, byNum(sheet.pit, 22).num);

  assert.equal(sheet.totH.avg, '.330');
  assert.equal(sheet.totH.ab, 1731);
  assert.equal(sheet.totH.h, 572);
  assert.equal(sheet.totH.hr, 96);
  assert.equal(sheet.totH.bb, 320);
  assert.equal(sheet.totH.k, 384);
  assert.equal(sheet.totH.hbp, 67);
  assert.equal(sheet.totH.obp, '.445');
  assert.equal(sheet.totH.slg, '.587');
  assert.equal(sheet.totH.sb, 118);
  assert.equal(sheet.totH.sf, 35);
  assert.equal(sheet.totH.sh, 14);
  assert.equal(sheet.totH.gdp, 1);
  assert.equal(sheet.totH.gp, 56);
  assert.notEqual(sheet.totH.avg, '.270');
  assert.equal(sheet.totP.era, '4.99');
  assert.equal(sheet.totP.ip, '432.2');
  assert.equal(sheet.totP.k, 481);
  assert.equal(sheet.totP.bb, 287);
  assert.equal(sheet.totP.hr, 30);
  assert.equal(sheet.totP.baa, '.245');
  assert.equal(sheet.totP.hbp, 67);
  assert.equal(sheet.totP.w, 42);
  assert.equal(sheet.totP.l, 13);
  assert.equal(sheet.record, '43-13');

  assert.deepEqual(sheet.cat.map(function (c) { return c.num + ':' + c.sba + '-' + c.csb; }).sort(), ['30:41-6', '31:43-13', '33:4-1']);
  var sba = sheet.cat.reduce(function (n, c) { return n + c.sba; }, 0);
  var csb = sheet.cat.reduce(function (n, c) { return n + c.csb; }, 0);
  assert.equal(sba, 88);
  assert.equal(csb, 20);

  sheet.hit.concat(sheet.pit).forEach(function (r) {
    assert.equal(r.bats, undefined);
    assert.equal(r.throws, undefined);
  });
  var rosterCsv = fs.readFileSync(ROSTER_CSV, 'utf8');
  var rosterRows = rosterCsv.split('\n').slice(1).filter(function (ln) { return ln.trim(); });
  assert.equal(rosterRows.length, 40);
  var roster = rosterIndex(rosterCsv);
  // Three redshirts share the RS number. They are not in the cumulative tables.
  assert.equal(rosterRows.filter(function (ln) { return ln.split(',')[0] === 'RS'; }).length, 3);
  sheet.hit.concat(sheet.pit).forEach(function (r) {
    var who = roster[r.num];
    assert.ok(who, 'jersey ' + r.num + ' ' + r.name);
    var got = statName(r.name);
    assert.equal(got.last, who.last, r.name);
    assert.equal(got.first, who.first, r.name);
    assert.equal(who.batsThrows, '');
  });
});

test('Walters Presto cumulative still matches the dotted-leader sheet', function () {
  var sheet = packet.parseStatSheet(extracted.walters.rows);
  assert.equal(sheet.team, 'Walters State Community College');
  assert.equal(sheet.season, '2025-26');
  assert.equal(sheet.record, '53-13');
  assert.equal(sheet.confRecord, '24-6');
  assert.equal(sheet.totH.gp, 66);
  assert.equal(sheet.skipped, 0);
  assert.equal(sheet.hit.length, 16);
  assert.equal(sheet.pit.length, 18);
  assert.equal(sheet.cat.length, 0);
  assert.deepEqual(pick(byNum(sheet.hit, 22), HIT_KEYS), {
    num: '22', name: 'Holden Pantier', avg: '.476', ab: 248, h: 118, db: 32, hr: 30,
    slg: '.992', bb: 35, hbp: 13, k: 25, gdp: 2, obp: '.546', sf: 8, sh: 0, sb: 16
  });
  assert.equal(byNum(sheet.hit, 22).gp, 66);
  assert.equal(byNum(sheet.hit, 22).gs, 66);
  assert.deepEqual(pick(byNum(sheet.pit, 14), PIT_KEYS), {
    num: '14', name: 'Major Osbolt', era: '4.56', w: 8, l: 1, app: 17, gs: 15, sv: 0,
    ip: '73.0', k: 102, bb: 29, hr: 10, baa: '.238', wp: 4, hbp: 8
  });
  assert.equal(byNum(sheet.pit, 36).hbp, 0);
  assert.equal(byNum(sheet.pit, 36).ip, '22.1');
  assert.equal(byNum(sheet.pit, 28).bb, 0);
  assert.equal(byNum(sheet.pit, 28).ip, '3.1');
  assert.equal(byNum(sheet.hit, 24).hr, 0);
  assert.equal(byNum(sheet.hit, 24).ab, 4);
  assert.equal(sheet.totH.avg, '.376');
  assert.equal(sheet.totH.ab, 2039);
  assert.equal(sheet.totH.hr, 154);
  assert.equal(sheet.totH.slg, '.692');
  assert.equal(sheet.totH.bb, 358);
  assert.equal(sheet.totH.hbp, 130);
  assert.equal(sheet.totH.k, 415);
  assert.equal(sheet.totH.gdp, 13);
  assert.equal(sheet.totH.obp, '.489');
  assert.equal(sheet.totH.sb, 113);
  assert.equal(sheet.totP.era, '6.25');
  assert.equal(sheet.totP.ip, '467.2');
  assert.equal(sheet.totP.k, 613);
  assert.equal(sheet.totP.bb, 238);
  assert.equal(sheet.totP.hr, 67);
  assert.equal(sheet.totP.baa, '.262');
  assert.equal(sheet.totP.hbp, 88);
  assert.equal(sheet.hit.some(function (h) { return /Derrick|Blankenship/.test(h.name); }), false);
  assert.equal(sheet.pit.some(function (p) { return /Blankenship|Derrick/.test(p.name); }), false);
  assert.equal(byNum(sheet.hit, 30).name, 'Drew Blalock');
  assert.equal(byNum(sheet.pit, 30).name, 'Drew Blalock');
});

test('doubled PDF text and a second upload do not duplicate players', function () {
  var once = packet.parseStatSheet(extracted.murray.rows);
  var doubled = packet.assembleStatTeams([{ rowsText: extracted.murray.rows + '\n' + extracted.murray.rows }]);
  assert.equal(doubled.length, 1);
  assert.equal(doubled[0].hit.length, 16);
  assert.equal(doubled[0].pit.length, 18);
  assert.equal(doubled[0].cat.length, 3);
  assert.equal(byNum(doubled[0].hit, 22).ab, 194);
  assert.equal(doubled[0].cat.reduce(function (n, c) { return n + c.sba; }, 0), 88);

  var twice = packet.assembleStatTeams([
    { rowsText: extracted.murray.rows },
    { rowsText: extracted.murray.rows }
  ]);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].hit.length, once.hit.length);
  assert.equal(twice[0].pit.length, once.pit.length);
  assert.equal(byNum(twice[0].pit, 34).ip, '77.2');

  var both = packet.assembleStatTeams([
    { rowsText: extracted.murray.rows },
    { rowsText: extracted.walters.rows }
  ]);
  assert.deepEqual(both.map(function (t) { return t.team; }).sort(), [
    'Murray State College',
    'Walters State Community College'
  ]);
  // One cumulative already has both disciplines. It is one team, not two uploads.
  assert.equal(packet.assembleStatTeams([{ rowsText: extracted.murray.rows }]).length, 1);
});

test('a shorter pitching line cannot replace the season line', function () {
  assert.equal(packet.ipOuts('0.1'), 1);
  assert.equal(packet.ipOuts('0.2'), 2);
  assert.equal(packet.ipOuts('1.0'), 3);
  assert.equal(packet.ipOuts('53.1'), 160);
  assert.equal(packet.ipOuts('77.2'), 233);
  assert.equal(packet.ipOuts('432.2'), 1298);
  var kept = packet.dedupePitchers([
    { num: '34', name: 'Dome, Tayte', ip: '77.2', era: '4.87' },
    { num: '34', name: 'Tayte Dome', ip: '10.0', era: '9.00' }
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].ip, '77.2');
  assert.equal(kept[0].era, '4.87');
});

test('unsupported or zero-player input is an error, not an empty team', function () {
  var junk = packet.parseStatSheet('Roster\n5 Smith R/R\nHello batting\n');
  assert.equal(junk.hit.length, 0);
  assert.equal(junk.pit.length, 0);
  var msg = packet.statSheetProblem(junk);
  assert.match(msg, /No hitters or pitchers were read/);
  assert.match(msg, /Presto/);
  assert.match(msg, /Sidearm/);
  assert.match(msg, /paste the cumulative table/i);
  assert.deepEqual(packet.assembleStatTeams([{ rowsText: 'Roster\n5 Smith R/R' }]), []);

  var headerOnly = [
    '# Player AVG GP-GS AB R H 2B 3B HR RBI TB SLG% BB HBP SO GDP OB% SF SH SB-ATT PO A E FLD%',
    'Totals .000 0-0 0 0 0 0 0 0 0 0 .000 0 0 0 0 .000 0 0 0-0 0 0 0 .000'
  ].join('\n');
  var empty = packet.parseStatSheet(headerOnly);
  assert.equal(empty.sawTable, true);
  assert.equal(empty.hit.length, 0);
  assert.match(packet.statSheetProblem(empty), /no player rows were read/i);
  assert.equal(packet.statSheetProblem(packet.parseStatSheet(extracted.murray.rows)), '');

  var dirty = extracted.murray.rows + '\n99 Nobody, Here 1 2\n';
  var parsed = packet.parseStatSheet(dirty);
  assert.equal(parsed.hit.length, 16);
  assert.equal(parsed.pit.length, 18);
  assert.equal(parsed.hit.concat(parsed.pit).some(function (r) { return r.num === '99'; }), false);
});

test('counting stats feed all three packet paths; Synergy cards are not claimed', function () {
  var teams = packet.assembleStatTeams([
    { rowsText: extracted.murray.rows },
    { rowsText: extracted.walters.rows }
  ]);
  function sides(selected) {
    var opp = teams.filter(function (t) { return t.team === selected; })[0];
    var ours = teams.filter(function (t) { return t.team !== selected; })[0];
    return { opp: opp, ours: ours };
  }
  var scoutMurray = sides('Murray State College');
  assert.equal(scoutMurray.opp.record, '43-13');
  assert.equal(scoutMurray.opp.totH.hr, 96);
  assert.equal(scoutMurray.opp.hit.length, 16);
  assert.equal(scoutMurray.opp.pit.length, 18);
  assert.equal(scoutMurray.ours.team, 'Walters State Community College');
  assert.equal(scoutMurray.ours.record, '53-13');
  assert.equal(scoutMurray.ours.totH.hr, 154);
  var scoutWalters = sides('Walters State Community College');
  assert.equal(scoutWalters.opp.record, '53-13');
  assert.equal(scoutWalters.ours.record, '43-13');
  assert.equal(scoutWalters.opp.team === scoutWalters.ours.team, false);

  ['scout/index.html', 'tools/scouting-ingest.html'].forEach(function (file) {
    var html = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(html, /\{id:'hitbook'[^}]*build:'hit'/);
    assert.match(html, /\{id:'pitbook'[^}]*build:'pit'/);
    assert.match(html, /\{id:'gameplan'[^}]*build:'gp'/);
    var usLine = html.indexOf("lbl\">'+usName");
    var oppLine = html.indexOf("lbl\">'+oppName");
    assert.ok(usLine > 0 && oppLine > usLine, file);
    assert.equal(html.indexOf('FIP'), -1, file);
  });
  assert.equal(fs.readFileSync(path.join(__dirname, 'scout/index.html'), 'utf8'), fs.readFileSync(path.join(__dirname, 'tools/scouting-ingest.html'), 'utf8'));
});

test('sample parsed output matches the PDF.js parse', function () {
  var sample = {
    extractor: 'PDF.js 3.11.174 getTextContent, then the same buildViews the Press Box page uses',
    murray: publicSheet(packet.parseStatSheet(extracted.murray.rows)),
    walters: publicSheet(packet.parseStatSheet(extracted.walters.rows)),
    notes: {
      synergy: 'No Synergy hitter or pitcher files were imported. Staff-table counting stats, pitcher counting lines, and the game-plan comparison totals are covered. Arsenal, chase, platoon, and card reads are not claimed.',
      rosterHands: 'The Murray roster reference has no B/T column. Hands were not inferred.',
      rosterMap: 'Separate remaining issue: rosterBT and rosterThrows are still global maps keyed only by jersey, so two teams can overwrite each other. This import does not change that.',
      gorman: 'Brae Gorman is included. His 162.0 ERA is drawn above the row in the Sidearm PDF. An earlier 33-row / 31-player count had dropped him. This sheet is 34 batting-plus-pitching rows and 32 distinct players.'
    }
  };
  if (process.env.WRITE_SAMPLE) fs.writeFileSync(SAMPLE, JSON.stringify(sample, null, 2) + '\n');
  var saved = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  assert.deepEqual(saved, sample);
});
