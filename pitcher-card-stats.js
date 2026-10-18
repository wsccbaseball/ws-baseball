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
    'Pitch', 'N', '%', 'Avg', 'Max', 'iVB', 'HB', 'Spin', 'VAA', 'HAA', 'RelH', 'Ext', 'Zn%', 'Whf%', 'Str%'
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

  return {
    VAA_FIELD: VAA_FIELD,
    HAA_FIELD: HAA_FIELD,
    PITCH_TABLE_COLUMNS: PITCH_TABLE_COLUMNS,
    finiteOrNull: finiteOrNull,
    mean: mean,
    formatAngle: formatAngle,
    approachFromPitch: approachFromPitch,
    angleCells: angleCells
  };
});
