const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const stats = require('./pitcher-card-stats');

test('approach angles are the native TrackMan fields', function () {
  assert.equal(stats.VAA_FIELD, 'VertApprAngle');
  assert.equal(stats.HAA_FIELD, 'HorzApprAngle');
  assert.deepEqual(stats.approachFromPitch({
    VertApprAngle: '-3.7',
    HorzApprAngle: '1.1',
    RelSpeed: 98
  }), { vaa: -3.7, haa: 1.1 });
});

test('VAA then HAA sit after Spin and before release height', function () {
  var cols = stats.PITCH_TABLE_COLUMNS;
  var spin = cols.indexOf('Spin');
  assert.deepEqual(cols.slice(spin, spin + 4), ['Spin', 'VAA', 'HAA', 'RelH']);
});

test('means are one decimal, signed, and skip missing angles', function () {
  assert.equal(stats.formatAngle(-3.74), '-3.7');
  assert.equal(stats.formatAngle(1.14), '1.1');
  assert.equal(stats.formatAngle(-0.04), '0.0');
  assert.equal(stats.formatAngle(null), '\u2014');
  assert.equal(stats.formatAngle(''), '\u2014');

  // A blank must not be treated as 0. Mean of -5 and missing stays -5.0.
  assert.equal(stats.mean([-5, null, '', 'nope']), -5);
  assert.equal(stats.mean([]), null);
  assert.equal(stats.mean([null, undefined]), null);

  var cells = stats.angleCells([-5.74, null, -3.7], [1.14, '', -0.86]);
  assert.deepEqual(cells, { vaa: '-4.7', haa: '0.1' });
});

test('an All row uses the same pitch-weighted mean as a pitch-type row', function () {
  var pitches = [
    { VertApprAngle: -5.7, HorzApprAngle: 1.1 },
    { VertApprAngle: -5.7, HorzApprAngle: 1.1 },
    { VertApprAngle: -8.5, HorzApprAngle: 2.5 },
    { VertApprAngle: null, HorzApprAngle: null }
  ];
  var angles = pitches.map(stats.approachFromPitch);
  var fastballs = stats.angleCells(
    [angles[0].vaa, angles[1].vaa],
    [angles[0].haa, angles[1].haa]
  );
  var all = stats.angleCells(
    angles.map(function (a) { return a.vaa; }),
    angles.map(function (a) { return a.haa; })
  );
  assert.deepEqual(fastballs, { vaa: '-5.7', haa: '1.1' });
  // Missing pitch is omitted. (-5.7 + -5.7 + -8.5) / 3 = -6.633... -> -6.6
  assert.deepEqual(all, { vaa: '-6.6', haa: '1.6' });
});

test('the game card header and rows use those columns and means', function () {
  var html = fs.readFileSync(__dirname + '/pitcher-report.html', 'utf8');
  assert.match(html, /<th>Spin<\/th><th>VAA<\/th><th>HAA<\/th><th>RelH<\/th>/);
  assert.match(html, /<th>Zn%<\/th><th>Whf%<\/th>/);
  assert.equal(html.indexOf('min-width:600px'), -1);
  assert.match(html, /PitcherCardStats\.approachFromPitch/);
  assert.match(html, /PitcherCardStats\.angleCells/);
  assert.match(html, /src="pitcher-card-stats\.js"/);
  assert.equal(stats.PITCH_TABLE_COLUMNS.indexOf('Str%'), -1);
  assert.equal(stats.PITCH_TABLE_COLUMNS[stats.PITCH_TABLE_COLUMNS.length - 1], 'Whf%');
  assert.match(html, /<th>HBP<\/th><th>Strike%<\/th><th>Whiffs<\/th>/);
  assert.match(html, /id="cSP"/);
  assert.equal(html.indexOf('Str%'), -1);
  assert.equal(html.indexOf('>Str%<'), -1);
});
