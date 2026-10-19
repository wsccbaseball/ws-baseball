// Approach angles on the pitcher game summary card.
// VAA and HAA are the native TrackMan fields VertApprAngle and HorzApprAngle,
// in degrees. The card shows the pitch-weighted mean. It does not derive an
// angle from velocity or acceleration.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PitcherCardStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var VAA_FIELD = 'VertApprAngle';
  var HAA_FIELD = 'HorzApprAngle';

  // TJStats order: VAA then HAA sit after Spin and before release height.
  var PITCH_TABLE_COLUMNS = [
    'Pitch', 'N', '%', 'Avg', 'Max', 'iVB', 'HB', 'Spin', 'VAA', 'HAA', 'RelH', 'Ext', 'Zn%', 'Whf%'
  ];

  function finiteOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }

  // Pitch-weighted mean. Missing angles are left out, so a blank does not
  // become 0 and pull the mean toward zero.
  function mean(values) {
    if (!values || !values.length) return null;
    var sum = 0;
    var n = 0;
    for (var i = 0; i < values.length; i++) {
      var v = finiteOrNull(values[i]);
      if (v === null) continue;
      sum += v;
      n++;
    }
    return n ? sum / n : null;
  }

  // Degrees, one decimal, signed. A rounded negative zero prints as 0.0.
  function formatAngle(v) {
    var n = finiteOrNull(v);
    if (n === null) return '\u2014';
    var text = n.toFixed(1);
    return text === '-0.0' ? '0.0' : text;
  }

  function approachFromPitch(row) {
    return {
      vaa: finiteOrNull(row && row[VAA_FIELD]),
      haa: finiteOrNull(row && row[HAA_FIELD])
    };
  }

  function angleCells(vaaValues, haaValues) {
    return {
      vaa: formatAngle(mean(vaaValues)),
      haa: formatAngle(mean(haaValues))
    };
  }

  // TrackMan spells a foul three ways (FoulBall, FoulBallNotFieldable,
  // FoulBallFieldable) and has used the plain spelling in some exports.
  // Any call that starts with Foul is a foul. Anything else stays on the map;
  // an unknown call stays a ball, which is what the card did before.
  var CALL_MAP = {
    StrikeCalled: 'Strike',
    StrikeSwinging: 'Whiff',
    BallCalled: 'Ball',
    InPlay: 'InPlay',
    HitByPitch: 'Ball',
    BallIntentional: 'Ball'
  };
  var STRIKE_CLASSES = ['Strike', 'Whiff', 'InPlay', 'Foul'];

  function classifyPitchCall(pitchCall) {
    var call = pitchCall == null ? '' : String(pitchCall).trim();
    if (/^foul/i.test(call)) return 'Foul';
    return CALL_MAP[call] || 'Ball';
  }

  // Strike% counts called strikes, whiffs, fouls, and balls in play.
  // labels are already classified (Strike / Whiff / InPlay / Foul / Ball).
  function strikePct(labels) {
    var n = labels ? labels.length : 0;
    if (!n) return '\u2014';
    var strikes = 0;
    for (var i = 0; i < n; i++) {
      if (STRIKE_CLASSES.indexOf(labels[i]) >= 0) strikes++;
    }
    return (strikes / n * 100).toFixed(1) + '%';
  }

  // Movement plot x is raw HorzBreak: negative on the left, positive on the
  // right. That is the pitcher's view, same direction as the location plots
  // (positive PlateLocSide to the pitcher's right). A righty's arm is on the
  // right; a lefty's arm is on the left. The words flip. The dots do not, so
  // the axis still matches the raw HB column and both hands share one plot.
  function isLeftHand(throws) {
    var hand = String(throws == null ? '' : throws).trim().toLowerCase();
    return hand === 'left' || hand === 'l' || hand === 'lhp';
  }

  function movementLabels(throws) {
    if (isLeftHand(throws)) return { left: '\u2190 Arm', right: 'Glove \u2192' };
    return { left: '\u2190 Glove', right: 'Arm \u2192' };
  }

  return {
    VAA_FIELD: VAA_FIELD,
    HAA_FIELD: HAA_FIELD,
    PITCH_TABLE_COLUMNS: PITCH_TABLE_COLUMNS,
    finiteOrNull: finiteOrNull,
    mean: mean,
    formatAngle: formatAngle,
    approachFromPitch: approachFromPitch,
    angleCells: angleCells,
    classifyPitchCall: classifyPitchCall,
    STRIKE_CLASSES: STRIKE_CLASSES,
    strikePct: strikePct,
    isLeftHand: isLeftHand,
    movementLabels: movementLabels
  };
});
