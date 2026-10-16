const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('./hitting-card-stats');

function pitch(partial) {
  return Object.assign({
    PitchCall: 'BallCalled',
    PlateLocSide: 0,
    PlateLocHeight: 2.5,
    ExitSpeed: '',
    Angle: '',
    TaggedHitType: '',
    PlayResult: ''
  }, partial);
}

test('fall seasons are detected from the id or the label', function () {
  assert.equal(stats.isFallSeason('2026-fall', '2026 Fall'), true);
  assert.equal(stats.isFallSeason('2026-FALL', ''), true);
  assert.equal(stats.isFallSeason('', 'Fall 2026'), true);
  assert.equal(stats.isFallSeason('2026-spring', '2026 Spring'), false);
  assert.equal(stats.isFallSeason('2026-spring', ''), false);
  assert.equal(stats.isFallSeason('', ''), false);
});

test('chase heat value is swing rate outside the Chase% zone', function () {
  assert.equal(stats.chaseHeatValue(pitch({ PitchCall: 'StrikeSwinging' })), null);
  assert.equal(stats.chaseHeatValue(pitch({ PlateLocSide: 0.833, PlateLocHeight: 1.5, PitchCall: 'InPlay' })), null);
  assert.equal(stats.chaseHeatValue(pitch({ PlateLocSide: 0, PlateLocHeight: 3.5, PitchCall: 'FoulBall' })), null);
  assert.equal(stats.chaseHeatValue(pitch({ PlateLocSide: 0.834, PlateLocHeight: 2.5, PitchCall: 'StrikeSwinging' })), 1);
  assert.equal(stats.chaseHeatValue(pitch({ PlateLocSide: -1.2, PlateLocHeight: 2.5, PitchCall: 'FoulBallFieldable' })), 1);
  assert.equal(stats.chaseHeatValue(pitch({ PlateLocSide: 1.1, PlateLocHeight: 1.2, PitchCall: 'BallCalled' })), 0);
  assert.equal(stats.chaseHeatValue(pitch({ PlateLocSide: 1.1, PlateLocHeight: 4.2, PitchCall: 'StrikeCalled' })), 0);
  assert.equal(stats.chaseHeatValue(pitch({ PlateLocSide: '', PlateLocHeight: 0.5, PitchCall: 'InPlay' })), null);
  assert.equal(stats.isInZone(0.833, 3.5), true);
  assert.equal(stats.isOutOfZone(0.834, 2.5), true);
  assert.equal(stats.isOutOfZone(0, 1.49), true);
});

test('rates match the card formulas, including the top-half best speed', function () {
  var rows = [
    pitch({ PitchCall: 'StrikeSwinging' }),
    pitch({ PitchCall: 'StrikeCalled' }),
    pitch({
      PitchCall: 'InPlay', PlateLocSide: 1.2, PlateLocHeight: 2.5,
      ExitSpeed: 100, Angle: 20, TaggedHitType: 'FlyBall', PlayResult: 'Single'
    }),
    pitch({ PitchCall: 'BallCalled', PlateLocSide: -1.2, PlateLocHeight: 2.0 }),
    pitch({
      PitchCall: 'InPlay', PlateLocSide: 0.2, PlateLocHeight: 2.0,
      ExitSpeed: 80, Angle: 5, TaggedHitType: 'GroundBall', PlayResult: 'Out'
    }),
    pitch({
      PitchCall: 'FoulBall', PlateLocSide: 1.0, PlateLocHeight: 1.0,
      ExitSpeed: 96, Angle: 15, TaggedHitType: 'FlyBall'
    })
  ];
  var tm = stats.trackmanRates(rows);
  assert.equal(tm.swingPct, 4 / 6);
  assert.equal(tm.whiffPct, 1 / 4);
  assert.equal(tm.zSwingPct, 2 / 3);
  assert.equal(tm.chasePct, 2 / 3);
  assert.equal(tm.seagerScore, 0);
  assert.equal(tm.hardHit, 2 / 3);
  assert.equal(tm.solidPct, 1);
  assert.equal(tm.gbPct, 1 / 2);
  assert.equal(tm.fbPct, 1 / 2);
  assert.equal(tm.bestSpeed, 98);
  assert.equal(tm.maxEV, 100);
  assert.equal(stats.formatTeamPct(tm.chasePct), 'Team 66.7%');
  assert.equal(stats.formatTeamNumber(tm.bestSpeed), 'Team 98.0');
  assert.equal(stats.formatTeamPoints(tm.seagerScore), 'Team 0.0%');
  assert.equal(stats.formatTeamNumber(0), 'Team --');
});

function peakCol(built) {
  var best = -1, col = -1;
  for (var i = 0; i < built.weight.length; i++) {
    if (built.weight[i] > best) { best = built.weight[i]; col = i % built.gw; }
  }
  return col;
}

function cellX(built, col) {
  return built.xMin + col / (built.gw - 1) * (built.xMax - built.xMin);
}

test('chase uses the same PlateLocSide flip as the other heat maps', function () {
  // Inside the plot (|side| <= 1.00) and outside the zone (|side| > 0.833).
  var right = pitch({ PlateLocSide: 0.95, PlateLocHeight: 2.4, PitchCall: 'StrikeSwinging' });
  var chase = stats.buildHeatGrid([right], stats.chaseHeatValue, { sigma: stats.HEAT_SIGMA_RATE });
  var woba = stats.buildHeatGrid([right], function () { return 0.4; }, { sigma: stats.HEAT_SIGMA_RATE, legacyCutoff: true });
  assert.equal(stats.displayPlateSide(0.95), -0.95);
  assert.ok(Math.max.apply(null, chase.weight) > 0.9);
  assert.equal(peakCol(chase), peakCol(woba));
  assert.ok(peakCol(chase) < chase.gw / 2);
  assert.ok(cellX(chase, peakCol(chase)) < 0);

  var left = pitch({ PlateLocSide: -0.95, PlateLocHeight: 2.4, PitchCall: 'FoulBall' });
  var chaseLeft = stats.buildHeatGrid([left], stats.chaseHeatValue, { sigma: stats.HEAT_SIGMA_RATE });
  var whiff = stats.buildHeatGrid([left], function () { return 1; }, { sigma: stats.HEAT_SIGMA_RATE, legacyCutoff: true });
  assert.ok(Math.max.apply(null, chaseLeft.weight) > 0.9);
  assert.equal(peakCol(chaseLeft), peakCol(whiff));
  assert.ok(peakCol(chaseLeft) > chaseLeft.gw / 2);
  assert.ok(cellX(chaseLeft, peakCol(chaseLeft)) > 0);
  assert.notEqual(peakCol(chase), peakCol(chaseLeft));
});

test('chase shrinks a sparse swing toward the prior and does not fill empty cells', function () {
  var prior = 0.2;
  var n = stats.CHASE_PRIOR_PITCHES;
  var swing = pitch({ PlateLocSide: 0.95, PlateLocHeight: 2.4, PitchCall: 'StrikeSwinging' });
  var built = stats.buildHeatGrid([swing], stats.chaseHeatValue, {
    sigma: stats.HEAT_SIGMA_RATE,
    priorRate: prior,
    priorPitches: n
  });
  var peak = 0, peakI = 0, far = -1;
  for (var i = 0; i < built.weight.length; i++) {
    if (built.weight[i] > peak) { peak = built.weight[i]; peakI = i; }
    if (built.weight[i] === 0 && far < 0) far = i;
  }
  assert.ok(Math.abs(peak - 1) < 1e-5);
  var expected = (1 + n * prior) / (1 + n);
  assert.ok(Math.abs(built.grid[peakI] - expected) < 1e-5);
  assert.ok(expected < 0.4, 'a lone swing must not stay near 100%');
  assert.ok(far >= 0);
  assert.equal(built.weight[far], 0);
  assert.ok(Math.abs(built.grid[far] - prior) < 1e-5);
  assert.equal(stats.lowDensityAlpha(0), 0);
  assert.equal(stats.lowDensityAlpha(built.weight[far]), 0);
  assert.ok(stats.lowDensityAlpha(peak) > 0.7);
});

test('chase is blank inside the zone and fades in outside it', function () {
  assert.equal(stats.chaseZoneAlpha(0, 2.5), 0);
  assert.equal(stats.chaseZoneAlpha(0.833, 2.5), 0);
  assert.equal(stats.chaseZoneAlpha(0, 1.5), 0);
  assert.equal(stats.chaseZoneAlpha(0, 3.5), 0);
  var edge = stats.chaseZoneAlpha(0.833 + stats.ZONE_FEATHER / 2, 2.5);
  assert.ok(edge > 0.2 && edge < 0.8);
  assert.equal(stats.chaseZoneAlpha(1.2, 2.5), 1);
  assert.equal(stats.chaseZoneAlpha(0, 4.2), 1);
  var prev = 0;
  for (var x = 0.833; x <= 1.2; x += 0.01) {
    var a = stats.chaseZoneAlpha(x, 2.5);
    assert.ok(a + 1e-9 >= prev);
    assert.ok(a - prev < 0.25);
    prev = a;
  }
});

test('low-density alpha fades instead of a hard stair', function () {
  assert.equal(stats.lowDensityAlpha(0), 0);
  assert.equal(stats.lowDensityAlpha(undefined), 0);
  assert.equal(stats.lowDensityAlpha(5), 1);
  var prev = 0;
  for (var w = 0; w <= 2; w += 0.05) {
    var a = stats.lowDensityAlpha(w);
    assert.ok(a + 1e-9 >= prev);
    assert.ok(a - prev < 0.2);
    prev = a;
  }
  var pitchRow = pitch({ PlateLocSide: 0.2, PlateLocHeight: 2.5, PitchCall: 'StrikeSwinging' });
  var density = stats.buildHeatGrid([pitchRow], function () { return 1; }, {
    sigma: stats.HEAT_SIGMA_DENSITY,
    densityMode: true
  });
  var legacy = stats.buildHeatGrid([pitchRow], function () { return 1; }, {
    sigma: stats.HEAT_SIGMA_DENSITY,
    densityMode: true,
    legacyCutoff: true
  });
  var maxW = 0;
  for (var i = 0; i < density.weight.length; i++) {
    if (density.weight[i] > maxW) maxW = density.weight[i];
  }
  assert.ok(Math.abs(maxW - 1) < 1e-5);
  assert.equal(density.grid[0], density.weight[0]);
  assert.equal(density.weight[0], 0);
  assert.ok(isNaN(legacy.grid[0]));
  var mid = stats.sampleBilinear(density.weight, density.gw, density.gh, 1.5, 1.5);
  var a = density.weight[1 * density.gw + 1];
  var b = density.weight[1 * density.gw + 2];
  var c = density.weight[2 * density.gw + 1];
  var d = density.weight[2 * density.gw + 2];
  assert.ok(Math.abs(mid - (a + b + c + d) / 4) < 1e-5);
});

test('chase prior uses the hitter rate, then the team rate', function () {
  var oz = [pitch({ PlateLocSide: 1.2, PlateLocHeight: 2.2 })];
  assert.equal(stats.chasePriorRate(oz, 0.19, 0.25), 0.19);
  assert.equal(stats.chasePriorRate([pitch({ PlateLocSide: 0, PlateLocHeight: 2.5 })], 0, 0.201), 0.201);
  assert.equal(stats.chasePriorRate([], null, null), 0);
  var scale = stats.colorScale([0.2, 0.22], 0, 1, 0.12);
  assert.ok(Math.abs((scale.max - scale.min) - 0.12) < 1e-9);
  var wide = stats.colorScale([0.05, 0.6], 0, 1, 0.12);
  assert.ok(Math.abs(wide.min - 0.05) < 1e-9);
  assert.ok(Math.abs(wide.max - 0.6) < 1e-9);
});

test('team rates are pitch-weighted, not the mean of player rates', function () {
  var chaser = [pitch({ PitchCall: 'InPlay', PlateLocSide: 1.5, PlateLocHeight: 2.5, ExitSpeed: 100, Angle: 20, TaggedHitType: 'FlyBall' })];
  var patient = [];
  for (var i = 0; i < 99; i++) {
    patient.push(pitch({ PitchCall: 'BallCalled', PlateLocSide: -1.4, PlateLocHeight: 2.2 }));
  }
  var meanOfPlayers = (stats.trackmanRates(chaser).chasePct + stats.trackmanRates(patient).chasePct) / 2;
  var pooled = stats.teamTrackman(chaser.concat(patient));
  assert.equal(meanOfPlayers, 0.5);
  assert.equal(pooled.chasePct, 0.01);
  assert.ok(Math.abs(pooled.chasePct - meanOfPlayers) > 0.4);
  assert.equal(stats.formatTeamPct(pooled.chasePct), 'Team 1.0%');
  // One hard ball in play against 99 takes: hard% is 100% of tracked contact,
  // while a mean of the two players' hard% would be 50%.
  assert.equal(pooled.hardHit, 1);
  assert.equal((stats.trackmanRates(chaser).hardHit + stats.trackmanRates(patient).hardHit) / 2, 0.5);
});
