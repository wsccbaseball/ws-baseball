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
  assert.equal(stats.chaseHeatValue(pitch({ PlateLocSide: -1.2, PlateLocHeight: 2.5, PitchCall: 'FoulBall' })), 1);
  assert.equal(stats.chaseHeatValue(pitch({ PlateLocSide: -1.2, PlateLocHeight: 2.5, PitchCall: 'FoulTip' })), 1);
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

test('chase map swings sit outside the 1.0 ft box, not the Chase% zone', function () {
  assert.equal(stats.isInsideChaseBox(1, 1.5), true);
  assert.equal(stats.isInsideChaseBox(1, 3.5), true);
  assert.equal(stats.isInsideChaseBox(0, 2.5), true);
  assert.equal(stats.isInsideChaseBox(1.01, 2.5), false);
  assert.equal(stats.isInsideChaseBox(0, 1.49), false);
  assert.equal(stats.isChaseSwing(pitch({ PlateLocSide: 0.9, PlateLocHeight: 2.5, PitchCall: 'StrikeSwinging' })), false);
  assert.equal(stats.isOutOfZone(0.9, 2.5), true);
  assert.equal(stats.isChaseSwing(pitch({ PlateLocSide: 1.01, PlateLocHeight: 2.5, PitchCall: 'StrikeSwinging' })), true);
  assert.equal(stats.isChaseSwing(pitch({ PlateLocSide: -1.2, PlateLocHeight: 2.5, PitchCall: 'FoulBall' })), true);
  assert.equal(stats.isChaseSwing(pitch({ PlateLocSide: -1.2, PlateLocHeight: 2.5, PitchCall: 'FoulBallNotFieldable' })), true);
  assert.equal(stats.isChaseSwing(pitch({ PlateLocSide: -1.2, PlateLocHeight: 2.5, PitchCall: 'FoulBallFieldable' })), true);
  assert.equal(stats.isChaseSwing(pitch({ PlateLocSide: 0, PlateLocHeight: 0.4, PitchCall: 'InPlay' })), true);
  assert.equal(stats.isChaseSwing(pitch({ PlateLocSide: 1.5, PlateLocHeight: 2.2, PitchCall: 'BallCalled' })), false);
  assert.equal(stats.isChaseSwing(pitch({ PlateLocSide: 1.5, PlateLocHeight: 2.2, PitchCall: 'StrikeCalled' })), false);
  assert.equal(stats.isChaseSwing(pitch({ PlateLocSide: '', PlateLocHeight: 0.4, PitchCall: 'InPlay' })), false);
  var dots = stats.chaseSwingDots([
    pitch({ PlateLocSide: 1.2, PlateLocHeight: 2.5, PitchCall: 'StrikeSwinging' }),
    pitch({ PlateLocSide: 0.9, PlateLocHeight: 2.5, PitchCall: 'InPlay' }),
    pitch({ PlateLocSide: 0, PlateLocHeight: 1.2, PitchCall: 'FoulBallFieldable' }),
    pitch({ PlateLocSide: 3.2, PlateLocHeight: 2.5, PitchCall: 'InPlay' }),
    pitch({ PlateLocSide: -1.4, PlateLocHeight: 4.2, PitchCall: 'BallCalled' })
  ]);
  assert.deepEqual(dots, [
    { x: -1.2, z: 2.5 },
    { x: -0, z: 1.2 }
  ]);
  // A swing between the strike zone and the chase box still counts in Chase%.
  var edge = [pitch({ PlateLocSide: 0.9, PlateLocHeight: 2.5, PitchCall: 'StrikeSwinging' })];
  assert.equal(stats.trackmanRates(edge).chasePct, 1);
  assert.equal(stats.isChaseSwing(edge[0]), false);
});

test('chase density is a 0.35 ft gaussian normalized by its own max', function () {
  var swing = pitch({ PlateLocSide: 1.5, PlateLocHeight: 2.0, PitchCall: 'StrikeSwinging' });
  var built = stats.buildChaseDensity([swing], { grid: 121 });
  assert.equal(built.xMin, -2.6);
  assert.equal(built.xMax, 2.6);
  assert.equal(built.yMin, 0.2);
  assert.equal(built.yMax, 5.0);
  var max = 0, maxI = 0;
  for (var i = 0; i < built.grid.length; i++) {
    if (built.grid[i] > max) { max = built.grid[i]; maxI = i; }
  }
  assert.ok(Math.abs(max - 1) < 1e-5);
  var col = maxI % built.gw;
  var row = Math.floor(maxI / built.gw);
  var x = built.xMin + col / (built.gw - 1) * (built.xMax - built.xMin);
  var z = built.yMax - row / (built.gh - 1) * (built.yMax - built.yMin);
  assert.ok(Math.abs(x - (-1.5)) < 0.05, 'peak x ' + x);
  assert.ok(Math.abs(z - 2.0) < 0.05, 'peak z ' + z);
  function at(dx, dz) {
    var gx = (x + dx - built.xMin) / (built.xMax - built.xMin) * (built.gw - 1);
    var gy = (built.yMax - (z + dz)) / (built.yMax - built.yMin) * (built.gh - 1);
    return stats.sampleBilinear(built.grid, built.gw, built.gh, gx, gy);
  }
  var side = at(stats.CHASE_SIGMA_FT, 0);
  var up = at(0, stats.CHASE_SIGMA_FT);
  var far = at(1.15, 0);
  assert.ok(Math.abs(side - Math.exp(-0.5)) < 0.06, 'sigma ft, got ' + side);
  assert.ok(Math.abs(up - side) < 0.06, 'x and z sigma differ: ' + side + ' vs ' + up);
  assert.ok(far < 0.02, 'kernel still wide, far=' + far);

  var cluster = [];
  for (var n = 0; n < 8; n++) cluster.push(pitch({ PlateLocSide: 1.6, PlateLocHeight: 2.4, PitchCall: 'InPlay' }));
  cluster.push(pitch({ PlateLocSide: -1.8, PlateLocHeight: 0.7, PitchCall: 'FoulBall' }));
  var mixed = stats.buildChaseDensity(cluster, { grid: 96 });
  assert.ok(Math.abs(Math.max.apply(null, mixed.grid) - 1) < 1e-5);
  var loneX = stats.displayPlateSide(-1.8);
  var lgx = (loneX - mixed.xMin) / (mixed.xMax - mixed.xMin) * (mixed.gw - 1);
  var lgy = (mixed.yMax - 0.7) / (mixed.yMax - mixed.yMin) * (mixed.gh - 1);
  var lone = stats.sampleBilinear(mixed.grid, mixed.gw, mixed.gh, lgx, lgy);
  assert.ok(lone > 0.08 && lone < 0.25, 'isolated swing should not read full red, got ' + lone);
});

test('chase colormap and plot geometry match the map spec', function () {
  assert.deepEqual(stats.chaseColor(0), [0x2f, 0x6d, 0xb3]);
  assert.deepEqual(stats.chaseColor(0.25), [0x7a, 0xa7, 0xd9]);
  assert.deepEqual(stats.chaseColor(0.5), [255, 255, 255]);
  assert.deepEqual(stats.chaseColor(0.75), [0xf0, 0xa3, 0xa3]);
  assert.deepEqual(stats.chaseColor(1), [0xc5, 0x30, 0x30]);
  assert.equal(stats.CHASE_DOT_FILL, '#1a202c');
  assert.equal(stats.CHASE_DOT_STROKE, '#ffffff');
  assert.equal(stats.CHASE_DOT_ALPHA, 0.75);
  var lay = stats.chasePlotLayout(400, 320, 8);
  var ftX = (stats.CHASE_X_MAX - stats.CHASE_X_MIN) / lay.width;
  var ftZ = (stats.CHASE_Z_MAX - stats.CHASE_Z_MIN) / lay.height;
  assert.ok(Math.abs(ftX - ftZ) < 1e-9);
  assert.ok(lay.left >= 8 - 1e-6 && lay.top >= 8 - 1e-6);
  assert.ok(lay.left + lay.width <= 400 + 1e-6);
  assert.ok(lay.top + lay.height <= 320 + 1e-6);
  assert.deepEqual(stats.chaseColor(0), stats.chaseColor(-1));
});

test('rate maps use absolute scales and mask thin smoothed counts', function () {
  assert.equal(stats.whiffScaleT(0), 0);
  assert.equal(stats.whiffScaleT(0.25), 0.5);
  assert.equal(stats.whiffScaleT(0.50), 1);
  assert.equal(stats.whiffScaleT(0.80), 1);
  assert.deepEqual(stats.chaseColor(stats.whiffScaleT(0.25)), [255, 255, 255]);
  assert.deepEqual(stats.chaseColor(stats.whiffScaleT(0.50)), [0xc5, 0x30, 0x30]);
  assert.deepEqual(stats.chaseColor(stats.whiffScaleT(0)), [0x2f, 0x6d, 0xb3]);
  assert.equal(stats.wobaScaleT(0), 0);
  assert.ok(Math.abs(stats.wobaScaleT(0.45) - 0.5) < 1e-9);
  assert.equal(stats.wobaScaleT(0.90), 1);
  assert.equal(stats.wobaScaleT(2.08), 1);
  assert.equal(stats.countFadeAlpha(0), 0);
  assert.equal(stats.countFadeAlpha(stats.COUNT_FADE_LO), 0);
  assert.equal(stats.countFadeAlpha(2), 0);
  assert.equal(stats.countFadeAlpha(stats.COUNT_FADE_HI), 1);
  assert.equal(stats.countFadeAlpha(8), 1);
  assert.equal(stats.showsHeat(7), false);
  assert.equal(stats.showsHeat(8), true);
  assert.equal(stats.HEAT_MIN_EVENTS, 8);

  var same = pitch({ PlateLocSide: 1.4, PlateLocHeight: 2.2, PitchCall: 'StrikeSwinging' });
  var foul = pitch({ PlateLocSide: 1.4, PlateLocHeight: 2.2, PitchCall: 'FoulBall' });
  var take = pitch({ PlateLocSide: 1.4, PlateLocHeight: 2.2, PitchCall: 'BallCalled' });
  var whiff = stats.buildRateSurface([same, foul, take], stats.whiffRateValue, { grid: 97 });
  var x = stats.displayPlateSide(1.4);
  var gx = (x - whiff.xMin) / (whiff.xMax - whiff.xMin) * (whiff.gw - 1);
  var gy = (whiff.yMax - 2.2) / (whiff.yMax - whiff.yMin) * (whiff.gh - 1);
  var rate = stats.sampleBilinear(whiff.grid, whiff.gw, whiff.gh, gx, gy);
  var weight = stats.sampleBilinear(whiff.weight, whiff.gw, whiff.gh, gx, gy);
  assert.ok(Math.abs(rate - 0.5) < 0.05, 'whiff rate ' + rate);
  assert.ok(weight > 1.2, 'two swings should thicken the denominator, weight ' + weight);

  var out = pitch({ PlateLocSide: -1.7, PlateLocHeight: 1.0, PitchCall: 'InPlay', PlayResult: 'Out' });
  var single = pitch({ PlateLocSide: 1.8, PlateLocHeight: 3.2, PitchCall: 'InPlay', PlayResult: 'Single' });
  var surface = stats.buildRateSurface([out, out, single, single], stats.wobaWeight, { grid: 97 });
  function at(side, height) {
    var px = stats.displayPlateSide(side);
    var ix = (px - surface.xMin) / (surface.xMax - surface.xMin) * (surface.gw - 1);
    var iy = (surface.yMax - height) / (surface.yMax - surface.yMin) * (surface.gh - 1);
    return stats.sampleBilinear(surface.grid, surface.gw, surface.gh, ix, iy);
  }
  assert.ok(Math.abs(at(-1.7, 1.0) - 0) < 0.05, 'outs stay near 0');
  assert.ok(Math.abs(at(1.8, 3.2) - 0.88) < 0.05, 'singles stay near 0.88');

  assert.equal(stats.wobaWeight(pitch({ PitchCall: 'InPlay', PlayResult: 'HomeRun' })), 2.08);
  assert.equal(stats.wobaWeight(pitch({ PitchCall: 'FoulBall' })), null);
  assert.equal(stats.whiffRateValue(pitch({ PitchCall: 'InPlay' })), 0);
  assert.equal(stats.whiffRateValue(pitch({ PitchCall: 'StrikeSwinging' })), 1);
  assert.equal(stats.whiffRateValue(take), null);

  var dots = stats.swingDots([
    same,
    foul,
    take,
    pitch({ PlateLocSide: 4, PlateLocHeight: 2, PitchCall: 'StrikeSwinging' })
  ]);
  assert.equal(dots.length, 2);
  assert.equal(dots[0].whiff, true);
  assert.equal(dots[0].x, stats.displayPlateSide(1.4));
  assert.equal(dots[1].whiff, false);
  var bip = stats.wobaDots([out, single, foul]);
  assert.equal(bip.length, 2);
  assert.equal(stats.meanWobaOnBip([out, single, foul]), 0.44);
  assert.equal(stats.whiffRateOnSwings([same, foul, take]), 0.5);
  assert.equal(stats.WHIFF_SCALE_MAX, 0.5);
  assert.equal(stats.WOBA_SCALE_MAX, 0.9);
  assert.equal(stats.WOBA_SIGMA_FT, 0.45);

  var pile = [];
  for (var k = 0; k < 5; k++) pile.push(pitch({ PlateLocSide: 1.4, PlateLocHeight: 2.2, PitchCall: 'BallCalled' }));
  var counted = stats.buildCountSurface(pile, function () { return true; }, { grid: 97, sigmaFeet: stats.CHASE_SIGMA_FT });
  var cx = (x - counted.xMin) / (counted.xMax - counted.xMin) * (counted.gw - 1);
  var cy = (counted.yMax - 2.2) / (counted.yMax - counted.yMin) * (counted.gh - 1);
  var count = stats.sampleBilinear(counted.weight, counted.gw, counted.gh, cx, cy);
  assert.ok(count > 4.2 && count < 5.4, 'five stacked pitches count near 5, got ' + count);
  assert.ok(stats.countFadeAlpha(count) > 0.99, 'five stacked pitches are opaque, fade ' + stats.countFadeAlpha(count));

  var wide = stats.buildRateSurface([single], stats.wobaWeight, { grid: 97, sigmaFeet: stats.WOBA_SIGMA_FT });
  var tight = stats.buildRateSurface([single], stats.wobaWeight, { grid: 97, sigmaFeet: stats.CHASE_SIGMA_FT });
  function weightAt(built, dx) {
    var px = stats.displayPlateSide(1.8) + dx;
    var ix = (px - built.xMin) / (built.xMax - built.xMin) * (built.gw - 1);
    var iy = (built.yMax - 3.2) / (built.yMax - built.yMin) * (built.gh - 1);
    return stats.sampleBilinear(built.weight, built.gw, built.gh, ix, iy);
  }
  assert.ok(weightAt(wide, 0.45) > weightAt(tight, 0.45), 'wOBA kernel is wider than chase');
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
