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
