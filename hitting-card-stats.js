// Season Hitting Summary rates. Chase%, Whiff%, and the gray team lines use
// the 0.833 ft strike zone and do not follow the heat-map box. All four heat
// maps share one window and a 1.0 ft zone box. Chase is a density normalized
// on that card. Whiff color is an absolute 0–50% scale. wOBA color is an
// absolute 0–0.90 scale on completed plate appearances, plotted at the final
// pitch. Team lines are pitch- or BIP-weighted over the pooled rows rather
// than a mean of players.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HittingCardStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Same calls the season card treats as a swing. Any PitchCall that starts
  // with Foul counts, including FoulBall, FoulBallNotFieldable, and
  // FoulBallFieldable. A new TrackMan spelling must not fall through.
  var SWING_CALLS = ['StrikeSwinging', 'FoulBall', 'FoulBallNotFieldable', 'FoulBallFieldable', 'InPlay'];

  function isFoulCall(call) {
    return /^Foul/i.test(String(call == null ? '' : call).trim());
  }

  function isSwingCall(call) {
    call = String(call == null ? '' : call).trim();
    return isFoulCall(call) || SWING_CALLS.indexOf(call) >= 0;
  }
  // The rectangle Chase% and Z-Swing% use. A pitch on the edge is in the zone.
  var ZONE_HALF_W = 0.833;
  var ZONE_BOT = 1.5;
  var ZONE_TOP = 3.5;
  // Shared heat-map box. Wider than the strike zone. A pitch on the edge is
  // inside the box. Chase dots are swings outside it; the box is drawn on
  // every map.
  var CHASE_BOX_HALF_W = 1.0;
  var CHASE_X_MIN = -2.6;
  var CHASE_X_MAX = 2.6;
  var CHASE_Z_MIN = 0.2;
  var CHASE_Z_MAX = 5.0;
  // Feet. Isotropic Gaussian, about half the smear of the old cell kernel on a
  // ~30-swing cloud (scipy gaussian_kde bw_method=0.45 lands near this).
  var CHASE_SIGMA_FT = 0.35;
  var CHASE_DOT_FILL = '#1a202c';
  var CHASE_DOT_STROKE = '#ffffff';
  var CHASE_DOT_ALPHA = 0.75;
  var CHASE_DOT_RADIUS = 5;
  var CHASE_CMAP = ['#2f6db3', '#7aa7d9', '#ffffff', '#f0a3a3', '#c53030'];
  // wOBA weights on balls in play. Outs, errors, fielder's choices, and
  // sacrifices are 0. Walk and hit-by-pitch match the box-score wOBA on this
  // card (0.69 and 0.72).
  var WOBA_WEIGHTS = { 'Single': 0.88, 'Double': 1.24, 'Triple': 1.56, 'HomeRun': 2.08, 'Home Run': 2.08 };
  var WOBA_BB = 0.69;
  var WOBA_HBP = 0.72;
  // Absolute color scales. The five stops run from t=0 (blue) to t=1 (red).
  // Whiff: 0% blue, 25% white, 50% and above red.
  // wOBA: 0.00 blue (strikeout or out), 0.45 white, 0.90 and above red
  // (about a single). Wider than the chase kernel.
  var WHIFF_SCALE_MAX = 0.50;
  var WOBA_SCALE_MAX = 0.90;
  var WOBA_SIGMA_FT = 0.45;
  // Smoothed pitch count. One pitch peaks near weight 1. Heat fades in from
  // about 3 to 5 and is masked below that.
  var COUNT_FADE_LO = 3;
  var COUNT_FADE_HI = 5;
  // Fewer events than this: dots and the zone box, no heat.
  var HEAT_MIN_EVENTS = 8;
  var WHIFF_RING = '#c53030';

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
    return isSwingCall(call) ? 1 : 0;
  }

  // Inside the drawn chase box, edges included. This is not the Chase% zone.
  function isInsideChaseBox(side, height) {
    side = parseFloat(side);
    height = parseFloat(height);
    return !isNaN(side) && !isNaN(height) && Math.abs(side) <= CHASE_BOX_HALF_W && height >= ZONE_BOT && height <= ZONE_TOP;
  }

  // A chase swing for the heat map: StrikeSwinging, any foul, or InPlay,
  // located outside the 1.0 ft box. Takes are not chase swings.
  function isChaseSwing(row) {
    if (!row || !isSwingCall(row.PitchCall)) return false;
    var side = parseFloat(row.PlateLocSide);
    var height = parseFloat(row.PlateLocHeight);
    if (isNaN(side) || isNaN(height)) return false;
    return !isInsideChaseBox(side, height);
  }

  // Catcher-view dots, one per chase swing that falls inside the map window.
  function chaseSwingDots(rows) {
    var dots = [];
    (rows || []).forEach(function (r) {
      if (!isChaseSwing(r)) return;
      var x = displayPlateSide(r.PlateLocSide);
      var z = parseFloat(r.PlateLocHeight);
      if (isNaN(x) || x < CHASE_X_MIN || x > CHASE_X_MAX || z < CHASE_Z_MIN || z > CHASE_Z_MAX) return;
      dots.push({ x: x, z: z });
    });
    return dots;
  }

  function hexRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  var CHASE_CMAP_RGB = CHASE_CMAP.map(hexRgb);

  // Five stops, t=0 blue through white to t=1 red. t is a density already
  // divided by that map's own maximum.
  function chaseColor(t) {
    if (!(t > 0)) return CHASE_CMAP_RGB[0].slice();
    if (t >= 1) return CHASE_CMAP_RGB[CHASE_CMAP_RGB.length - 1].slice();
    var scaled = t * (CHASE_CMAP_RGB.length - 1);
    var i = Math.min(CHASE_CMAP_RGB.length - 2, Math.floor(scaled));
    var f = scaled - i;
    var a = CHASE_CMAP_RGB[i];
    var b = CHASE_CMAP_RGB[i + 1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f)
    ];
  }

  // Largest equal-aspect rectangle inside the canvas. One foot is the same
  // number of pixels in x and z. There are no axis ticks; the caller draws
  // only the zone box and the dots.
  function chasePlotLayout(width, height, pad) {
    pad = pad == null ? 0 : pad;
    var availW = Math.max(1, width - pad * 2);
    var availH = Math.max(1, height - pad * 2);
    var spanX = CHASE_X_MAX - CHASE_X_MIN;
    var spanZ = CHASE_Z_MAX - CHASE_Z_MIN;
    var dataAspect = spanX / spanZ;
    var plotW;
    var plotH;
    if (availW / availH > dataAspect) {
      plotH = availH;
      plotW = plotH * dataAspect;
    } else {
      plotW = availW;
      plotH = plotW / dataAspect;
    }
    return {
      left: (width - plotW) / 2,
      top: (height - plotH) / 2,
      width: plotW,
      height: plotH,
      spanX: spanX,
      spanZ: spanZ
    };
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
    var sigmaFeet = opts.sigmaFeet == null ? null : (typeof opts.sigmaFeet === 'number' ? { x: opts.sigmaFeet, z: opts.sigmaFeet } : opts.sigmaFeet);
    var weightGrid = new Float32Array(GW * GH);
    var valueGrid = new Float32Array(GW * GH);
    var cellX = (X_MAX - X_MIN) / (GW - 1);
    var cellZ = (Y_MAX - Y_MIN) / (GH - 1);
    (rows || []).forEach(function (r) {
      var side = parseFloat(r.PlateLocSide);
      var height = parseFloat(r.PlateLocHeight);
      var shown = displayPlateSide(side);
      if (isNaN(shown) || isNaN(height)) return;
      if (shown < X_MIN || shown > X_MAX || height < Y_MIN || height > Y_MAX) return;
      if (!opts.keepEdge && (Math.abs(shown) > (X_MAX - 0.05) || height < (Y_MIN + 0.05) || height > (Y_MAX - 0.05))) return;
      var val = valueFn(r);
      if (val === null || val === undefined || isNaN(val)) return;
      var gx = (shown - X_MIN) / (X_MAX - X_MIN) * (GW - 1);
      var gy = (Y_MAX - height) / (Y_MAX - Y_MIN) * (GH - 1);
      if (sigmaFeet) {
        var sx = sigmaFeet.x;
        var sz = sigmaFeet.z;
        var radX = Math.ceil(3 * sx / cellX) + 1;
        var radZ = Math.ceil(3 * sz / cellZ) + 1;
        var cx = Math.round(gx);
        var cy = Math.round(gy);
        for (var dy = -radZ; dy <= radZ; dy++) {
          for (var dx = -radX; dx <= radX; dx++) {
            var ix = cx + dx, iy = cy + dy;
            if (ix < 0 || ix >= GW || iy < 0 || iy >= GH) continue;
            var ex = (X_MIN + ix * cellX - shown) / sx;
            var ez = (Y_MAX - iy * cellZ - height) / sz;
            var kFt = Math.exp(-0.5 * (ex * ex + ez * ez));
            weightGrid[iy * GW + ix] += kFt;
            valueGrid[iy * GW + ix] += kFt * val;
          }
        }
        return;
      }
      var sig = sigma * GW;
      var rad = Math.ceil(3 * sig);
      for (var dy2 = -rad; dy2 <= rad; dy2++) {
        for (var dx2 = -rad; dx2 <= rad; dx2++) {
          var ix2 = Math.round(gx + dx2), iy2 = Math.round(gy + dy2);
          if (ix2 < 0 || ix2 >= GW || iy2 < 0 || iy2 >= GH) continue;
          var dist2 = (dx2 * dx2 + dy2 * dy2) / (sig * sig);
          var k = Math.exp(-0.5 * dist2);
          weightGrid[iy2 * GW + ix2] += k;
          valueGrid[iy2 * GW + ix2] += k * val;
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

  // Density of chase swings only. Each swing contributes a Gaussian of
  // CHASE_SIGMA_FT in both x and z. The grid is divided by its own max so the
  // densest cluster is 1 (full red) on every card.
  function buildChaseDensity(rows, opts) {
    opts = opts || {};
    var built = buildHeatGrid(rows, function (r) {
      return isChaseSwing(r) ? 1 : null;
    }, {
      xMin: CHASE_X_MIN,
      xMax: CHASE_X_MAX,
      yMin: CHASE_Z_MIN,
      yMax: CHASE_Z_MAX,
      sigmaFeet: CHASE_SIGMA_FT,
      densityMode: true,
      keepEdge: true,
      grid: opts.grid || 96
    });
    var max = 0;
    for (var i = 0; i < built.grid.length; i++) {
      if (built.grid[i] > max) max = built.grid[i];
    }
    var norm = new Float32Array(built.grid.length);
    if (max > 0) {
      for (var j = 0; j < built.grid.length; j++) norm[j] = built.grid[j] / max;
    }
    built.density = built.grid;
    built.grid = norm;
    built.max = max;
    return built;
  }

  // Nadaraya-Watson rate on the shared window. valueFn returns the outcome for
  // a denominator event and null for every other pitch. grid[i] is
  // smoothed numerator / smoothed denominator. weight[i] is the denominator.
  function buildRateSurface(rows, valueFn, opts) {
    opts = opts || {};
    return buildHeatGrid(rows, valueFn, {
      xMin: CHASE_X_MIN,
      xMax: CHASE_X_MAX,
      yMin: CHASE_Z_MIN,
      yMax: CHASE_Z_MAX,
      sigmaFeet: opts.sigmaFeet != null ? opts.sigmaFeet : CHASE_SIGMA_FT,
      keepEdge: true,
      grid: opts.grid || 96
    });
  }

  // Smoothed count of the pitches includeFn keeps. Peak of one pitch is ~1,
  // so the grid is a local pitch count, not a rate.
  function buildCountSurface(rows, includeFn, opts) {
    opts = opts || {};
    return buildHeatGrid(rows, function (r) {
      if (includeFn && !includeFn(r)) return null;
      var side = parseFloat(r && r.PlateLocSide);
      var height = parseFloat(r && r.PlateLocHeight);
      if (isNaN(side) || isNaN(height)) return null;
      return 1;
    }, {
      xMin: CHASE_X_MIN,
      xMax: CHASE_X_MAX,
      yMin: CHASE_Z_MIN,
      yMax: CHASE_Z_MAX,
      sigmaFeet: opts.sigmaFeet != null ? opts.sigmaFeet : CHASE_SIGMA_FT,
      densityMode: true,
      keepEdge: true,
      grid: opts.grid || 96
    });
  }

  function showsHeat(eventCount) {
    return eventCount >= HEAT_MIN_EVENTS;
  }

  function wobaWeight(row) {
    if (!row || String(row.PitchCall || '').trim() !== 'InPlay') return null;
    return WOBA_WEIGHTS[row.PlayResult || ''] || 0;
  }

  function blankResult(v) {
    if (v == null) return true;
    var s = String(v).trim().toLowerCase();
    return !s || s === 'undefined' || s === 'none' || s === 'null' || s === 'nan';
  }

  function isHitByPitchRow(row) {
    if (!row) return false;
    if (String(row.PitchCall || '').trim() === 'HitByPitch') return true;
    if (blankResult(row.HitByPitch)) return false;
    var s = String(row.HitByPitch).trim().toLowerCase();
    return s !== '0' && s !== 'false' && s !== 'no';
  }

  function isIntentionalWalkText(v) {
    var s = blankResult(v) ? '' : String(v).trim().toLowerCase();
    return s === 'intentionalwalk' || s === 'intentional walk' || s === 'ibb';
  }

  // An intentional walk is dropped from wOBA. TrackMan marks the pitches
  // BallIntentional, or the final KorBB / PlayResult as an intentional walk.
  function isIntentionalWalk(pitches) {
    var last = pitches && pitches[pitches.length - 1];
    if (!last) return false;
    if (isIntentionalWalkText(last.KorBB) || isIntentionalWalkText(last.PlayResult)) return true;
    var kor = blankResult(last.KorBB) ? '' : String(last.KorBB).trim();
    if (kor !== 'Walk') return false;
    return pitches.some(function (r) {
      return String(r && r.PitchCall || '').trim() === 'BallIntentional';
    });
  }

  // Same plate-appearance split as the hitter card. Rows that cannot be keyed
  // stay in their own group, so a terminal pitch is still counted.
  function plateGroups(rows) {
    var api = typeof HitterPA !== 'undefined' ? HitterPA : null;
    if (!api && typeof require === 'function') {
      try { api = require('./hitter-pa.js'); } catch (e) { api = null; }
    }
    if (api && api.groupPlateAppearances) return api.groupPlateAppearances(rows);
    return (rows || []).map(function (r) { return [r]; });
  }

  // Weight of the pitch that ended a plate appearance. Null when this pitch
  // did not end one. Strikeout and out are 0, so they stay in the denominator.
  function wobaPaWeight(row) {
    if (!row || isIntentionalWalk([row])) return null;
    var kor = blankResult(row.KorBB) ? '' : String(row.KorBB).trim();
    if (kor === 'Strikeout') return 0;
    if (kor === 'Walk') return WOBA_BB;
    if (isHitByPitchRow(row)) return WOBA_HBP;
    if (String(row.PitchCall || '').trim() === 'InPlay') return wobaWeight(row);
    return null;
  }

  // Final pitch of each completed plate appearance. Earlier pitches in the
  // same PA are omitted. Intentional walks are omitted.
  function wobaPaPitches(rows) {
    var out = [];
    plateGroups(rows).forEach(function (pitches) {
      if (!pitches || !pitches.length || isIntentionalWalk(pitches)) return;
      var last = pitches[pitches.length - 1];
      if (wobaPaWeight(last) == null) return;
      out.push(last);
    });
    return out;
  }

  // 1 on a whiff, 0 on any other swing, null on a take. Denominator is swings.
  function whiffRateValue(row) {
    if (!row || !isSwingCall(row.PitchCall)) return null;
    return String(row.PitchCall).trim() === 'StrikeSwinging' ? 1 : 0;
  }

  // 0 at 0% whiff, 0.5 at 25%, 1 at 50% and above.
  function whiffScaleT(rate) {
    if (!isFinite(rate) || !(rate > 0)) return 0;
    var t = rate / WHIFF_SCALE_MAX;
    return t > 1 ? 1 : t;
  }

  // 0 at an out, 0.5 at 0.45, 1 at 0.90 and above.
  function wobaScaleT(value) {
    if (!isFinite(value) || !(value > 0)) return 0;
    var t = value / WOBA_SCALE_MAX;
    return t > 1 ? 1 : t;
  }

  function countFadeAlpha(weight) {
    if (!(weight > 0)) return 0;
    return smoothstep(COUNT_FADE_LO, COUNT_FADE_HI, weight);
  }

  function meanWobaOnBip(rows) {
    var n = 0, sum = 0;
    (rows || []).forEach(function (r) {
      var v = wobaWeight(r);
      if (v == null) return;
      n++;
      sum += v;
    });
    return n ? sum / n : null;
  }

  function whiffRateOnSwings(rows) {
    var n = 0, w = 0;
    (rows || []).forEach(function (r) {
      if (!r || !isSwingCall(r.PitchCall)) return;
      n++;
      if (String(r.PitchCall).trim() === 'StrikeSwinging') w++;
    });
    return n ? w / n : null;
  }

  function plotDot(row) {
    if (!row) return null;
    var x = displayPlateSide(row.PlateLocSide);
    var z = parseFloat(row.PlateLocHeight);
    if (isNaN(x) || isNaN(z) || x < CHASE_X_MIN || x > CHASE_X_MAX || z < CHASE_Z_MIN || z > CHASE_Z_MAX) return null;
    return { x: x, z: z };
  }

  // Completed plate appearances inside the window, at the final pitch.
  // Plain dots. Whiff rings stay on the whiff maps.
  function wobaDots(rows) {
    var dots = [];
    wobaPaPitches(rows).forEach(function (r) {
      var dot = plotDot(r);
      if (dot) dots.push(dot);
    });
    return dots;
  }

  // Swings inside the window. whiff marks the misses so the card can ring them.
  function swingDots(rows) {
    var dots = [];
    (rows || []).forEach(function (r) {
      if (!r || !isSwingCall(r.PitchCall)) return;
      var dot = plotDot(r);
      if (!dot) return;
      dot.whiff = String(r.PitchCall).trim() === 'StrikeSwinging';
      dots.push(dot);
    });
    return dots;
  }

  function trackmanRates(rows) {
    rows = rows || [];
    var swings = 0, whiffs = 0, inZone = 0, inZoneSwings = 0, ozPitches = 0, ozSwings = 0;
    var bip = [], maxEV = 0, evCount = 0, allEVs = [];
    var gbCount = 0, fbCount = 0, bipCount = 0, solidContact = 0;

    rows.forEach(function (r) {
      var call = (r.PitchCall || '').trim();
      var side = parseFloat(r.PlateLocSide), height = parseFloat(r.PlateLocHeight);
      var isSwing = isSwingCall(call);
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
    isFoulCall: isFoulCall,
    isSwingCall: isSwingCall,
    ZONE_HALF_W: ZONE_HALF_W,
    ZONE_BOT: ZONE_BOT,
    ZONE_TOP: ZONE_TOP,
    CHASE_BOX_HALF_W: CHASE_BOX_HALF_W,
    CHASE_X_MIN: CHASE_X_MIN,
    CHASE_X_MAX: CHASE_X_MAX,
    CHASE_Z_MIN: CHASE_Z_MIN,
    CHASE_Z_MAX: CHASE_Z_MAX,
    CHASE_SIGMA_FT: CHASE_SIGMA_FT,
    CHASE_DOT_FILL: CHASE_DOT_FILL,
    CHASE_DOT_STROKE: CHASE_DOT_STROKE,
    CHASE_DOT_ALPHA: CHASE_DOT_ALPHA,
    CHASE_DOT_RADIUS: CHASE_DOT_RADIUS,
    CHASE_CMAP: CHASE_CMAP,
    isInZone: isInZone,
    isOutOfZone: isOutOfZone,
    isInsideChaseBox: isInsideChaseBox,
    isChaseSwing: isChaseSwing,
    chaseSwingDots: chaseSwingDots,
    chaseColor: chaseColor,
    chasePlotLayout: chasePlotLayout,
    buildChaseDensity: buildChaseDensity,
    WOBA_WEIGHTS: WOBA_WEIGHTS,
    WOBA_BB: WOBA_BB,
    WOBA_HBP: WOBA_HBP,
    WHIFF_SCALE_MAX: WHIFF_SCALE_MAX,
    WOBA_SCALE_MAX: WOBA_SCALE_MAX,
    WOBA_SIGMA_FT: WOBA_SIGMA_FT,
    COUNT_FADE_LO: COUNT_FADE_LO,
    COUNT_FADE_HI: COUNT_FADE_HI,
    HEAT_MIN_EVENTS: HEAT_MIN_EVENTS,
    WHIFF_RING: WHIFF_RING,
    buildRateSurface: buildRateSurface,
    buildCountSurface: buildCountSurface,
    showsHeat: showsHeat,
    wobaWeight: wobaWeight,
    wobaPaWeight: wobaPaWeight,
    wobaPaPitches: wobaPaPitches,
    whiffRateValue: whiffRateValue,
    whiffScaleT: whiffScaleT,
    wobaScaleT: wobaScaleT,
    countFadeAlpha: countFadeAlpha,
    meanWobaOnBip: meanWobaOnBip,
    whiffRateOnSwings: whiffRateOnSwings,
    wobaDots: wobaDots,
    swingDots: swingDots,
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
