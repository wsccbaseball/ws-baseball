const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PitchType = require('./pitch-type');

test('tagged pitch type wins over auto', function () {
  assert.equal(PitchType.resolvePitchType('Fastball', 'Cutter'), 'Fastball');
  assert.equal(PitchType.resolvePitchType('Slider', 'Curveball'), 'Slider');
  assert.equal(PitchType.resolvePitchType('Sinker', 'Four-Seam'), 'Sinker');
  // A real tag of Other is a call, not a missing value.
  assert.equal(PitchType.resolvePitchType('Other', 'Slider'), 'Other');
  assert.equal(PitchType.resolvePitchType('  Fastball  ', 'Slider'), 'Fastball');
  assert.equal(
    PitchType.resolvePitchType({ TaggedPitchType: 'Fastball', AutoPitchType: 'Slider' }),
    'Fastball'
  );
});

test('blank or Undefined tagged type falls back to auto', function () {
  assert.equal(PitchType.resolvePitchType('', 'Slider'), 'Slider');
  assert.equal(PitchType.resolvePitchType('   ', 'Cutter'), 'Cutter');
  assert.equal(PitchType.resolvePitchType('Undefined', 'Four-Seam'), 'Four-Seam');
  assert.equal(PitchType.resolvePitchType('undefined', 'Sinker'), 'Sinker');
  assert.equal(PitchType.resolvePitchType(' UNDEFINED ', 'ChangeUp'), 'ChangeUp');
  assert.equal(PitchType.resolvePitchType(null, 'ChangeUp'), 'ChangeUp');
  assert.equal(PitchType.resolvePitchType(undefined, 'Slider'), 'Slider');
  assert.equal(PitchType.resolvePitchType('Undefined', ''), '');
  assert.equal(PitchType.resolvePitchType('Undefined', 'Undefined'), '');
  assert.equal(PitchType.resolvePitchType(null, null), '');
  assert.equal(
    PitchType.resolvePitchType({ TaggedPitchType: 'Undefined', AutoPitchType: 'Slider' }),
    'Slider'
  );
  assert.equal(
    PitchType.resolvePitchType({ TaggedPitchType: null, AutoPitchType: 'Cutter' }),
    'Cutter'
  );
});

test('Craver Vanderbilt fastballs stay in the tagged heater bucket', function () {
  // Auto typed these three heaters Cutter/Slider. The old report had no auto
  // fastball, so its fallback averaged the slider group (76.4, 72.7, 84.8) to 78.0.
  var pitches = [
    { TaggedPitchType: 'Fastball', AutoPitchType: 'Cutter', RelSpeed: 84.9 },
    { TaggedPitchType: 'Fastball', AutoPitchType: 'Cutter', RelSpeed: 85.7 },
    { TaggedPitchType: 'Fastball', AutoPitchType: 'Slider', RelSpeed: 84.8 },
    { TaggedPitchType: 'Slider', AutoPitchType: 'Slider', RelSpeed: 76.4 },
    { TaggedPitchType: 'Slider', AutoPitchType: 'Slider', RelSpeed: 72.7 },
    { TaggedPitchType: 'Slider', AutoPitchType: 'Curveball', RelSpeed: 77.0 }
  ];
  var norm = {
    'Four-Seam': 'Fastball', Fastball: 'Fastball', Sinker: 'Sinker',
    Slider: 'Slider', Cutter: 'Cutter', Curveball: 'Curveball'
  };
  var fb = pitches.filter(function (p) {
    var raw = PitchType.resolvePitchType(p);
    var bucket = norm[raw] || raw;
    return bucket === 'Fastball' || bucket === 'Sinker';
  }).map(function (p) { return p.RelSpeed; });
  assert.equal(fb.length, 3);
  var avg = fb.reduce(function (s, v) { return s + v; }, 0) / fb.length;
  assert.equal(Math.round(avg * 10) / 10, 85.1);

  var autoOnly = pitches.filter(function (p) {
    var raw = p.AutoPitchType;
    var bucket = norm[raw] || raw;
    return bucket === 'Fastball' || bucket === 'Sinker';
  });
  assert.equal(autoOnly.length, 0);
});

test('every report page groups pitches through the shared resolver', function () {
  var pages = [
    'pitcher-report.html',
    'ws-game-summary.html',
    'ws-season-hitting.html',
    'ws-season-pitching.html',
    'ws-stuff.html',
    'ws-whiff-debug.html',
    'hitter-report.html',
    'opposing-pitcher-scout.html'
  ];
  pages.forEach(function (name) {
    var html = fs.readFileSync(path.join(__dirname, name), 'utf8');
    assert.match(html, /src="pitch-type\.js"/, name + ' loads the helper');
    assert.match(html, /PitchType\.resolvePitchType/, name + ' calls the helper');
  });

  var summary = fs.readFileSync(path.join(__dirname, 'ws-game-summary.html'), 'utf8');
  assert.equal(summary.indexOf('TAGSRC'), -1);
  assert.equal(summary.indexOf('id="tagSel"'), -1);
  assert.equal(summary.indexOf('value="auto"'), -1);
  assert.match(summary, /PitchType\.resolvePitchType/);

  ['ws-stuff.html', 'ws-season-pitching.html'].forEach(function (name) {
    var html = fs.readFileSync(path.join(__dirname, name), 'utf8');
    assert.equal(html.indexOf("t === 'Other'"), -1, name);
    assert.equal(html.indexOf("t==='Other'"), -1, name);
  });
});
