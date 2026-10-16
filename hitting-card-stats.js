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
  // This does not touch PlateLocSide. Every heat map, including chase, flips
  // that sign once in buildHeatGrid (displaySide = -side) so the plot is the
  // catcher's view the card captions as "looking toward the pitcher".
  function chaseHeatValue(row) {
    if (!row || !isOutOfZone(row.PlateLocSide, row.PlateLocHeight)) return null;
    var call = String(row.PitchCall || '').trim();
    return SWING_CALLS.indexOf(call) >= 0 ? 1 : 0;
  }

  // Same grid and Gaussian the season card used inline. sigma is multiplied by
  // the grid width inside the kernel, matching the wOBA / whiff maps.
  var HEAT_GRID = 40;
  var HEAT_SIGMA_RATE = 0.10;
  var HEAT_SIGMA_DENSITY = 0.14;
  // Pseudo-pitches mixed into the local kernel weight. One real pitch adds
  // weight 1 at its cell, so 8 pulls a lone swing most of the way back to the
  // hitter's overall chase rate and lets a real cluster show through.
  var CHASE_PRIOR_PITCHES = 8;
  // Feet. Chase fades in across this band just outside the zone and is blank
  // on and inside the zone, where chase is undefined.
  var ZONE_FEATHER = 0.12;
  var DENSITY_ALPHA_LO = 0.08;
  var DENSITY_ALPHA_HI = 1.2;

  function displayPlateSide(side) {
    side = parseFloat(side);
    return isNaN(side) ? NaN : -side;
  }

  function smoothstep(edge0, edge1, x) {
    if (edge1 === edge0) return x >= edge1 ? 1 : 0;
    var t = (x - edge0) / (edge1 - edge0);
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  }

  // 0 inside and on the strike zone. Rises to 1 a feather-width outside it,
  // including rounded corners, so the mask has no hard edge.
  function outsideZoneDistance(side, height) {
    side = parseFloat(side);
    height = parseFloat(height);
    if (isNaN(side) || isNaN(height)) return 0;
    var ox = Math.max(Math.abs(side) - ZONE_HALF_W, 0);
    var oy = height < ZONE_BOT ? ZONE_BOT - height : height > ZONE_TOP ? height - ZONE_TOP : 0;
    if (ox === 0 && oy === 0) return 0;
    return Math.sqrt(ox * ox + oy * oy);
  }

  function chaseZoneAlpha(side, height) {
    return smoothstep(0, ZONE_FEATHER, outsideZoneDistance(side, height));
  }

  // Soft presence of the kernel. Zero weight is fully transparent. There is no
  // hard cutoff, which is what stair-stepped the empty corner of a whiff map.
  function lowDensityAlpha(weight) {
    if (!(weight > 0)) return 0;
    return smoothstep(DENSITY_ALPHA_LO, DENSITY_ALPHA_HI, weight);
  }

  // Outer footprint shared with the original maps: full color through the
  // zone plus 0.15 ft, then a 0.12 ft linear fade.
  function plotEdgeAlpha(x, y) {
    var edge = ZONE_HALF_W + 0.15;
    var eTop = ZONE_TOP + 0.15;
    var eBot = ZONE_BOT - 0.15;
    var dX = Math.max(0, Math.abs(x) - edge);
    var dY = Math.max(0, Math.max(eBot - y, y - eTop));
    var edgeDist = Math.max(dX, dY);
    if (edgeDist <= 0) return 1;
    return Math.max(0, 1 - edgeDist / 0.12);
  }

  function chasePriorRate(rows, playerRate, teamRate) {
    var oz = 0;
    (rows || []).forEach(function (r) {
      if (isOutOfZone(r.PlateLocSide, r.PlateLocHeight)) oz++;
    });
    if (oz > 0 && playerRate != null && !isNaN(playerRate)) return playerRate;
    if (teamRate != null && !isNaN(teamRate)) return teamRate;
    return 0;
  }

  function colorScale(validVals, minVal, maxVal, minRange) {
    var mn = validVals && validVals.length ? Math.min.apply(null, validVals) : minVal;
    var mx = validVals && validVals.length ? Math.max.apply(null, validVals) : maxVal;
    if (!(mx > mn)) {
      mn = minVal;
      mx = maxVal;
    }
    if (minRange && mx - mn < minRange) {
      var mid = (mn + mx) / 2;
      mn = mid - minRange / 2;
      mx = mid + minRange / 2;
    }
    return { min: mn, max: mx };
  }

  function sampleBilinear(grid, gw, gh, gx, gy) {
    if (!grid || gx < 0 || gy < 0 || gx > gw - 1 || gy > gh - 1) return NaN;
    var x0 = Math.floor(gx);
    var y0 = Math.floor(gy);
    var x1 = Math.min(gw - 1, x0 + 1);
    var y1 = Math.min(gh - 1, y0 + 1);
    var tx = gx - x0;
    var ty = gy - y0;
    function at(x, y) { return grid[y * gw + x]; }
    var v00 = at(x0, y0), v10 = at(x1, y0), v01 = at(x0, y1), v11 = at(x1, y1);
    if (isNaN(v00) || isNaN(v10) || isNaN(v01) || isNaN(v11)) {
      var nx = tx < 0.5 ? x0 : x1;
      var ny = ty < 0.5 ? y0 : y1;
      return at(nx, ny);
    }
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  }

  // Kernel-smoothed heat grid. PlateLocSide is negated once, for every map.
  // mode 'rate' keeps the historical NaN cutoff (wOBA). mode 'density' keeps
  // the raw kernel weight so low-density corners can fade instead of being
  // extrapolated. mode 'chase' is the out-of-zone swing rate shrunk toward
  // priorRate by priorPitches pseudo-observations.
  function buildHeatGrid(rows, valueFn, opts) {
    opts = opts || {};
    var X_MIN = (opts.xMin === null || opts.xMin === undefined) ? -1.05 : opts.xMin;
    var X_MAX = (opts.xMax === null || opts.xMax === undefined) ? 1.05 : opts.xMax;
    var Y_MIN = (opts.yMin === null || opts.yMin === undefined) ? 1.2 : opts.yMin;
    var Y_MAX = (opts.yMax === null || opts.yMax === undefined) ? 3.9 : opts.yMax;
    var GW = opts.grid || HEAT_GRID;
    var GH = GW;
    var sigma = opts.sigma != null ? opts.sigma : (opts.densityMode ? HEAT_SIGMA_DENSITY : HEAT_SIGMA_RATE);
    var weightGrid = new Float32Array(GW * GH);
    var valueGrid = new Float32Array(GW * GH);
    (rows || []).forEach(function (r) {
      var side = parseFloat(r.PlateLocSide);
      var height = parseFloat(r.PlateLocHeight);
      var shown = displayPlateSide(side);
      if (isNaN(shown) || isNaN(height)) return;
      if (shown < X_MIN || shown > X_MAX || height < Y_MIN || height > Y_MAX) return;
      if (Math.abs(shown) > (X_MAX - 0.05) || height < (Y_MIN + 0.05) || height > (Y_MAX - 0.05)) return;
      var val = valueFn(r);
      if (val === null || val === undefined || isNaN(val)) return;
      var gx = (shown - X_MIN) / (X_MAX - X_MIN) * (GW - 1);
      var gy = (Y_MAX - height) / (Y_MAX - Y_MIN) * (GH - 1);
      var sig = sigma * GW;
      var rad = Math.ceil(3 * sig);
      for (var dy = -rad; dy <= rad; dy++) {
        for (var dx = -rad; dx <= rad; dx++) {
          var ix = Math.round(gx + dx), iy = Math.round(gy + dy);
          if (ix < 0 || ix >= GW || iy < 0 || iy >= GH) continue;
          var dist2 = (dx * dx + dy * dy) / (sig * sig);
          var k = Math.exp(-0.5 * dist2);
          weightGrid[iy * GW + ix] += k;
          valueGrid[iy * GW + ix] += k * val;
        }
      }
    });
    var result = new Float32Array(GW * GH);
    var validVals = [];
    var chase = !opts.densityMode && opts.priorPitches > 0;
    var smoothDensity = !!opts.densityMode && !opts.legacyCutoff;
    for (var i = 0; i < GW * GH; i++) {
      var gx = i % GW;
      var gy = Math.floor(i / GW);
      var x = X_MIN + gx / (GW - 1) * (X_MAX - X_MIN);
      var y = Y_MAX - gy / (GH - 1) * (Y_MAX - Y_MIN);
      if (chase) {
        result[i] = (valueGrid[i] + opts.priorPitches * (opts.priorRate || 0)) / (weightGrid[i] + opts.priorPitches);
        if (weightGrid[i] >= 0.85 && outsideZoneDistance(x, y) >= 0.02) validVals.push(result[i]);
      } else if (smoothDensity) {
        result[i] = weightGrid[i];
        if (weightGrid[i] >= 0.45) validVals.push(weightGrid[i]);
      } else if (weightGrid[i] > 0.01) {
        result[i] = opts.densityMode ? weightGrid[i] : valueGrid[i] / weightGrid[i];
        validVals.push(result[i]);
      } else {
        result[i] = NaN;
      }
    }
    return {
      grid: result,
      weight: weightGrid,
      gw: GW,
      gh: GH,
      xMin: X_MIN,
      xMax: X_MAX,
      yMin: Y_MIN,
      yMax: Y_MAX,
      validVals: validVals
    };
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
    HEAT_GRID: HEAT_GRID,
    HEAT_SIGMA_RATE: HEAT_SIGMA_RATE,
    HEAT_SIGMA_DENSITY: HEAT_SIGMA_DENSITY,
    CHASE_PRIOR_PITCHES: CHASE_PRIOR_PITCHES,
    ZONE_FEATHER: ZONE_FEATHER,
    displayPlateSide: displayPlateSide,
    smoothstep: smoothstep,
    outsideZoneDistance: outsideZoneDistance,
    chaseZoneAlpha: chaseZoneAlpha,
    lowDensityAlpha: lowDensityAlpha,
    plotEdgeAlpha: plotEdgeAlpha,
    chasePriorRate: chasePriorRate,
    colorScale: colorScale,
    sampleBilinear: sampleBilinear,
    buildHeatGrid: buildHeatGrid,
    trackmanRates: trackmanRates,
    teamTrackman: teamTrackman,
    formatTeamPct: formatTeamPct,
    formatTeamNumber: formatTeamNumber,
    formatTeamPoints: formatTeamPoints
  };
});
