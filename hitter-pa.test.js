const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pa = require('./hitter-pa');

const beck = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'test/fixtures/beck-20261015-api-order.json'), 'utf8'));

function summary(rows) {
  return pa.groupPlateAppearances(rows).map(function (pitches) {
    return {
      pitcher: pa.pitcherLabel(pitches),
      result: pa.paResult(pitches).text,
      seq: pa.pitchSequence(pitches),
      inning: pitches[0].Inning,
      half: pitches[0]['Top/Bottom'],
      pa: pitches[0].PAofInning,
      inPlay: pitches.filter(function (r) { return r.PitchCall === 'InPlay'; }).length,
      ids: pitches.map(function (r) { return r.id; })
    };
  });
}

// The old card split a PA whenever the next row had PitchofPA 1. PostgREST
// does not return pitches in plate-appearance order, so that glued two balls
// in play onto one Slagle box and scrambled Cook.
function adjacencyGroups(rows) {
  var list = [];
  var current = [];
  rows.forEach(function (r) {
    if (parseInt(r.PitchofPA, 10) === 1 && current.length) {
      list.push(current);
      current = [];
    }
    current.push(r);
  });
  if (current.length) list.push(current);
  return list;
}

test('Beck 10/15 API order: 7 PAs, 2 walks, triple vs Slagle, Cook in pitch order', function () {
  var broken = adjacencyGroups(beck);
  assert.equal(broken.length, 8);
  var brokenTriple = broken.find(function (g) {
    return g.filter(function (r) { return r.PitchCall === 'InPlay'; }).length > 1;
  });
  assert.ok(brokenTriple, 'old grouping should still show the two-in-play bug on this fixture');
  assert.equal(pa.pitchSequence(brokenTriple), 'B-CS-B-IP-IP');

  var cards = summary(beck);
  assert.deepEqual(cards.map(function (c) { return c.pitcher + ' ' + c.result + ' ' + c.seq; }), [
    'Ozment (RHP) HR IP',
    'Gardner (RHP) BB B-B-B-B',
    'Scoggins (RHP) K CS-F-B-S',
    'Slagle (RHP) BB F-B-B-CS-B-B',
    'Slagle (RHP) 3B CS-CS-B-B-IP',
    'Cook (RHP) 1B B-S-CS-B-F-IP',
    'Derrick (LHP) 1B B-CS-B-IP'
  ]);
  assert.equal(cards.length, 7);
  assert.equal(cards.filter(function (c) { return c.result === 'BB'; }).length, 2);
  assert.equal(cards.filter(function (c) { return c.result === 'Undefined'; }).length, 0);
  cards.forEach(function (c) { assert.equal(c.inPlay <= 1, true); });

  var triple = cards.find(function (c) { return c.result === '3B'; });
  assert.equal(triple.pitcher, 'Slagle (RHP)');
  assert.equal(triple.inning, 8);
  assert.equal(triple.pa, 6);
  assert.equal(triple.ids[triple.ids.length - 1], 21468);
  assert.equal(triple.seq, 'CS-CS-B-B-IP');

  var cook = cards.find(function (c) { return c.pitcher.indexOf('Cook') === 0; });
  assert.equal(cook.result, '1B');
  assert.equal(cook.seq, 'B-S-CS-B-F-IP');
  assert.deepEqual(cook.ids, [21518, 21519, 21520, 21521, 21522, 21523]);
});

test('grouping ignores row order and stringified keys', function () {
  var shuffled = beck.slice().reverse().map(function (r) {
    return Object.assign({}, r, {
      Inning: String(r.Inning),
      PAofInning: String(r.PAofInning),
      PitchofPA: String(r.PitchofPA)
    });
  });
  assert.deepEqual(
    summary(shuffled).map(function (c) { return c.seq + ' ' + c.result; }),
    summary(beck).map(function (c) { return c.seq + ' ' + c.result; })
  );
});

test('same PAofInning in another half, inning, or game stays separate', function () {
  var rows = [
    { id: 1, GameID: 'G', Inning: 8, 'Top/Bottom': 'Bottom', PAofInning: 6, PitchofPA: 1, PitchNo: 1, Pitcher: 'Slagle, Rhett', PitcherThrows: 'Right', PitchCall: 'StrikeCalled', KorBB: 'Undefined', PlayResult: 'Undefined' },
    { id: 2, GameID: 'G', Inning: 8, 'Top/Bottom': 'Top', PAofInning: 6, PitchofPA: 1, PitchNo: 2, Pitcher: 'Other, A', PitcherThrows: 'Left', PitchCall: 'InPlay', KorBB: 'Undefined', PlayResult: 'Single' },
    { id: 3, GameID: 'G', Inning: 9, 'Top/Bottom': 'Bottom', PAofInning: 6, PitchofPA: 1, PitchNo: 3, Pitcher: 'Other, B', PitcherThrows: 'Right', PitchCall: 'InPlay', KorBB: 'Undefined', PlayResult: 'Out' },
    { id: 4, GameID: 'OTHER', Inning: 8, 'Top/Bottom': 'Bottom', PAofInning: 6, PitchofPA: 1, PitchNo: 4, Pitcher: 'Other, C', PitcherThrows: 'Right', PitchCall: 'BallCalled', KorBB: 'Walk', PlayResult: 'Undefined' }
  ];
  var cards = summary(rows);
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map(function (c) { return c.inning + ' ' + c.half + ' ' + c.pitcher + ' ' + c.result; }), [
    '8 Top Other (LHP) 1B',
    '8 Bottom Slagle (RHP) Undefined',
    '8 Bottom Other (RHP) BB',
    '9 Bottom Other (RHP) OUT'
  ]);
});

test('pitches order by PitchofPA and fall back to PitchNo', function () {
  var rows = [
    { id: 9, GameID: 'G', Inning: 1, 'Top/Bottom': 'Top', PAofInning: 1, PitchofPA: null, PitchNo: 30, Pitcher: 'A, A', PitcherThrows: 'Right', PitchCall: 'InPlay', KorBB: 'Undefined', PlayResult: 'Single' },
    { id: 8, GameID: 'G', Inning: 1, 'Top/Bottom': 'Top', PAofInning: 1, PitchofPA: '', PitchNo: 10, Pitcher: 'A, A', PitcherThrows: 'Right', PitchCall: 'BallCalled', KorBB: 'Undefined', PlayResult: 'Undefined' },
    { id: 7, GameID: 'G', Inning: 1, 'Top/Bottom': 'Bottom', PAofInning: 1, PitchofPA: 3, PitchNo: 1, Pitcher: 'B, B', PitcherThrows: 'Right', PitchCall: 'StrikeCalled', KorBB: 'Strikeout', PlayResult: 'Undefined' },
    { id: 6, GameID: 'G', Inning: 1, 'Top/Bottom': 'Bottom', PAofInning: 1, PitchofPA: 1, PitchNo: 99, Pitcher: 'B, B', PitcherThrows: 'Right', PitchCall: 'BallCalled', KorBB: 'Undefined', PlayResult: 'Undefined' }
  ];
  var cards = summary(rows);
  assert.deepEqual(cards.map(function (c) { return c.half + ' ' + c.seq; }), ['Top B-IP', 'Bottom B-CS']);
});

test('a row missing the PA key is not merged into a real plate appearance', function () {
  var rows = [
    { id: 1, GameID: 'G', Inning: 1, 'Top/Bottom': 'Bottom', PAofInning: 1, PitchofPA: 1, Pitcher: 'A, A', PitcherThrows: 'Right', PitchCall: 'InPlay', KorBB: 'Undefined', PlayResult: 'Single' },
    { id: 2, GameID: 'G', Inning: 1, 'Top/Bottom': 'Bottom', PAofInning: null, PitchofPA: 2, Pitcher: 'Cook, Tyler', PitcherThrows: 'Right', PitchCall: 'InPlay', KorBB: 'Undefined', PlayResult: 'Triple' }
  ];
  var cards = summary(rows);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].pitcher, 'A (RHP)');
  assert.equal(cards[1].pitcher, 'Cook (RHP)');
});

test('Undefined only when the final pitch has no PlayResult, KorBB, or HitByPitch', function () {
  function pitch(over) {
    return Object.assign({
      GameID: 'G', Inning: 1, 'Top/Bottom': 'Bottom', PAofInning: 1, PitchofPA: 1,
      Pitcher: 'A, A', PitcherThrows: 'Right', PitchCall: 'BallCalled',
      KorBB: 'Undefined', PlayResult: 'Undefined'
    }, over);
  }
  assert.equal(pa.paResult([pitch({})]).text, 'Undefined');
  assert.equal(pa.paResult([pitch({ KorBB: 'Walk', PlayResult: 'Undefined' })]).text, 'BB');
  assert.equal(pa.paResult([pitch({ PitchCall: 'HitByPitch' })]).text, 'HBP');
  assert.equal(pa.paResult([pitch({ HitByPitch: 'True', PitchCall: 'BallCalled' })]).text, 'HBP');
  assert.equal(pa.paResult([pitch({ PitchCall: 'InPlay', PlayResult: 'Triple' })]).text, '3B');
  assert.equal(pa.paResult([
    pitch({ PitchofPA: 1, PlayResult: 'Undefined', KorBB: 'Undefined' }),
    pitch({ PitchofPA: 2, PitchCall: 'InPlay', PlayResult: 'HomeRun', KorBB: 'Undefined' })
  ]).text, 'HR');
});

test('pitcher label comes from the pitches in the plate appearance', function () {
  var rows = [
    { GameID: 'G', Inning: 1, 'Top/Bottom': 'Bottom', PAofInning: 1, PitchofPA: 2, Pitcher: 'Cook, Tyler', PitcherThrows: 'Right', PitchCall: 'BallCalled', KorBB: 'Undefined', PlayResult: 'Undefined' },
    { GameID: 'G', Inning: 1, 'Top/Bottom': 'Bottom', PAofInning: 1, PitchofPA: 1, Pitcher: 'Slagle, Rhett', PitcherThrows: 'Right', PitchCall: 'BallCalled', KorBB: 'Undefined', PlayResult: 'Undefined' },
    { GameID: 'G', Inning: 1, 'Top/Bottom': 'Bottom', PAofInning: 1, PitchofPA: 3, Pitcher: 'Slagle, Rhett', PitcherThrows: 'Right', PitchCall: 'InPlay', KorBB: 'Undefined', PlayResult: 'Triple' }
  ];
  var cards = summary(rows);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].pitcher, 'Slagle (RHP)');
  assert.equal(cards[0].result, '3B');
  assert.equal(cards[0].seq, 'B-B-IP');
});

test('hitter card groups live pitches and does not read season prebuild files', function () {
  var html = fs.readFileSync(path.join(__dirname, 'hitter-report.html'), 'utf8');
  assert.match(html, /HitterPA\.groupPlateAppearances/);
  assert.doesNotMatch(html, /parseInt\(r\.PitchofPA\)===1/);
  assert.equal(html.includes('data/seasons'), false);
});
