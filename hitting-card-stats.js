// Season Hitting Summary rates. The card and the team line share this so a
// hitter's Chase% and the CHASE map use one strike zone, and team averages are
// pitch- or BIP-weighted over the pooled rows rather than a mean of players.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HittingCardStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Same calls the season card treats as a swing. FoulBallFieldable counts.
  var SWING_CALLS = ['StrikeSwinging', 'FoulBall', 'FoulBallNotFieldable', 'FoulBallFieldable', 'InPlay'];
  // The rectangle Chase% uses. A pitch on the edge is in the zone.
  var ZONE_HALF_W = 0.833;
  var ZONE_BOT = 1.5;
  var ZONE_TOP = 3.5;

  function isInZone(side, height) {
    side = parseFloat(side);
    height = parseFloat(height);
    return !isNaN(side) && !isNaN(height) && Math.abs(side) <= ZONE_HALF_W && height >= ZONE_BOT && height <= ZONE_TOP;
  }

  function isOutOfZone(side, height) {
    side = parseFloat(side);
    height = parseFloat(height);
    return !isNaN(side) && !isNaN(height) && !isInZone(side, height);
  }

  // Fall cards hide the box-score row. Match either the season id or its label.
  function isFallSeason(seasonId, seasonLabel) {
    var blob = (String(seasonId == null ? '' : seasonId) + ' ' + String(seasonLabel == null ? '' : seasonLabel)).toLowerCase();
    return blob.indexOf('fall') !== -1;
  }

  // Swing rate on pitches outside the strike zone. In-zone pitches are omitted
  // so the map is chase rate, not overall swing rate. 1 = swing, 0 = take.
  function chaseHeatValue(row) {
    if (!row || !isOutOfZone(row.PlateLocSide, row.PlateLocHeight)) return null;
    var call = String(row.PitchCall || '').trim();
    return SWING_CALLS.indexOf(call) >= 0 ? 1 : 0;
  }

  function trackmanRates(rows) {
    rows = rows || [];
    var swings = 0, whiffs = 0, inZone = 0, inZoneSwings = 0, ozPitches = 0, ozSwings = 0;
    var bip = [], maxEV = 0, evCount = 0, allEVs = [];
    var gbCount = 0, fbCount = 0, bipCount = 0, solidContact = 0;

    rows.forEach(function (r) {
      var call = (r.PitchCall || '').trim();
      var side = parseFloat(r.PlateLocSide), height = parseFloat(r.PlateLocHeight);
      var isSwing = SWING_CALLS.indexOf(call) >= 0;
      var isWhiff = call === 'StrikeSwinging';
      var inside = isInZone(side, height);
      var outside = isOutOfZone(side, height);
      if (isSwing) swings++;
      if (isWhiff) whiffs++;
      if (inside) { inZone++; if (isSwing) inZoneSwings++; }
      if (outside) { ozPitches++; if (isSwing) ozSwings++; }
      var ev = parseFloat(r.ExitSpeed);
      var la = parseFloat(r.Angle || r.LaunchAngle || r.VertAngle || 'NaN');
      if (!isNaN(ev) && ev > 0) {
        if (ev > maxEV) maxEV = ev;
        evCount++;
        allEVs.push(ev);
        if (!isNaN(side) && !isNaN(height)) {
          bip.push({ side: side, height: height, ev: ev, result: (r.PlayResult || '') });
        }
        if (!isNaN(la) && ev >= 95 && la >= 8 && la <= 32) solidContact++;
        if (call === 'InPlay') {
          bipCount++;
          var ht = (r.TaggedHitType || r.HitType || '').toLowerCase();
          if (ht.indexOf('ground') >= 0) gbCount++;
          else if (ht.indexOf('fly') >= 0 || ht.indexOf('popup') >= 0) fbCount++;
          else if (!isNaN(la)) { if (la < 10) gbCount++; else if (la >= 25) fbCount++; }
        }
      }
    });

    allEVs.sort(function (a, b) { return b - a; });
    var topHalf = allEVs.slice(0, Math.ceil(allEVs.length / 2));
    var bestSpeed = topHalf.length > 0 ? topHalf.reduce(function (a, b) { return a + b; }, 0) / topHalf.length : 0;
    var zSwingPct = inZone > 0 ? inZoneSwings / inZone : 0;
    var chasePct = ozPitches > 0 ? ozSwings / ozPitches : 0;

    return {
      swingPct: rows.length > 0 ? swings / rows.length : 0,
      whiffPct: swings > 0 ? whiffs / swings : 0,
      chasePct: chasePct,
      zSwingPct: zSwingPct,
      seagerScore: (zSwingPct - chasePct) * 100,
      hardHit: evCount > 0 ? bip.filter(function (b) { return b.ev >= 95; }).length / evCount : 0,
      solidPct: bipCount > 0 ? solidContact / bipCount : 0,
      gbPct: bipCount > 0 ? gbCount / bipCount : 0,
      fbPct: bipCount > 0 ? fbCount / bipCount : 0,
      bestSpeed: bestSpeed,
      maxEV: maxEV,
      bip: bip,
      totalPitches: rows.length
    };
  }

  // Pool every WSCC pitch in the current season/date range, then run the same
  // formulas once. Do not average the players' rates.
  function teamTrackman(rows) {
    return trackmanRates(rows);
  }

  function formatTeamPct(rate) {
    if (rate === null || rate === undefined || isNaN(rate)) return 'Team --';
    return 'Team ' + (rate * 100).toFixed(1) + '%';
  }

  // Best speed is an average of exit velo, so a team figure in the same units
  // is meaningful. Zero means there was no tracked contact.
  function formatTeamNumber(v, digits) {
    if (v === null || v === undefined || isNaN(v) || !(Number(v) > 0)) return 'Team --';
    return 'Team ' + Number(v).toFixed(digits == null ? 1 : digits);
  }

  // ZO% is already in percentage points (zone swing minus chase).
  function formatTeamPoints(v) {
    if (v === null || v === undefined || isNaN(v)) return 'Team --';
    return 'Team ' + Number(v).toFixed(1) + '%';
  }

  return {
    SWING_CALLS: SWING_CALLS,
    ZONE_HALF_W: ZONE_HALF_W,
    ZONE_BOT: ZONE_BOT,
    ZONE_TOP: ZONE_TOP,
    isInZone: isInZone,
    isOutOfZone: isOutOfZone,
    isFallSeason: isFallSeason,
    chaseHeatValue: chaseHeatValue,
    trackmanRates: trackmanRates,
    teamTrackman: teamTrackman,
    formatTeamPct: formatTeamPct,
    formatTeamNumber: formatTeamNumber,
    formatTeamPoints: formatTeamPoints
  };
});
