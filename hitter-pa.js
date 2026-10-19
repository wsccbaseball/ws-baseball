// Plate appearance identity is GameID + Inning + Top/Bottom + PAofInning.
// Pitch rows from PostgREST are not ordered, so adjacency and PitchofPA === 1
// cannot be used to split them.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HitterPA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parseNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var n = parseInt(String(v).trim(), 10);
    return isFinite(n) ? n : null;
  }

  function blank(v) {
    if (v == null) return true;
    var s = String(v).trim();
    if (!s) return true;
    var lower = s.toLowerCase();
    return lower === 'undefined' || lower === 'none' || lower === 'null' || lower === 'nan';
  }

  function halfOf(r) {
    var h = r['Top/Bottom'];
    if (h == null || h === '') h = r.TopBottom != null ? r.TopBottom : r.InningHalf;
    return h == null ? '' : String(h).trim();
  }

  function halfRank(half) {
    var h = String(half || '').trim().toLowerCase();
    if (h === 'top' || h === 't') return 0;
    if (h === 'bottom' || h === 'bot' || h === 'b') return 1;
    return 2;
  }

  // Null when the row cannot be placed in a real plate appearance.
  function paKey(r) {
    var game = r.GameID == null ? '' : String(r.GameID).trim();
    var inning = parseNum(r.Inning);
    var half = halfOf(r);
    var pa = parseNum(r.PAofInning);
    if (!game || inning == null || !half || pa == null) return null;
    return game + '|' + inning + '|' + half.toLowerCase() + '|' + pa;
  }

  function pitchRank(r, index) {
    var ofpa = parseNum(r.PitchofPA);
    var pno = parseNum(r.PitchNo);
    var id = parseNum(r.id);
    var primary = ofpa != null ? ofpa : (pno != null ? pno : 1e15);
    var tie = pno != null ? pno : (id != null ? id : index);
    return [primary, tie, id != null ? id : index, index];
  }

  function cmp(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  function groupPlateAppearances(rows) {
    var groups = [];
    var byKey = Object.create(null);
    (rows || []).forEach(function (r, index) {
      var key = paKey(r);
      var bucket = key || ('__row__' + index);
      var g = byKey[bucket];
      if (!g) {
        g = byKey[bucket] = { pitches: [], firstIndex: index, key: key };
        groups.push(g);
      }
      g.pitches.push({ row: r, index: index });
    });
    groups.forEach(function (g) {
      g.pitches.sort(function (a, b) {
        return cmp(pitchRank(a.row, a.index), pitchRank(b.row, b.index));
      });
      g.ordered = g.pitches.map(function (p) { return p.row; });
      var first = g.ordered[0] || {};
      g.sortKey = [
        parseNum(first.Inning) == null ? 1e15 : parseNum(first.Inning),
        halfRank(halfOf(first)),
        parseNum(first.PAofInning) == null ? 1e15 : parseNum(first.PAofInning),
        g.firstIndex
      ];
    });
    groups.sort(function (a, b) { return cmp(a.sortKey, b.sortKey); });
    return groups.map(function (g) { return g.ordered.slice(); });
  }

  function isHitByPitch(r) {
    if (!r) return false;
    if (r.PitchCall === 'HitByPitch') return true;
    if (blank(r.HitByPitch)) return false;
    var s = String(r.HitByPitch).trim().toLowerCase();
    return s !== '0' && s !== 'false' && s !== 'no';
  }

  function paResult(paPitches) {
    var last = paPitches && paPitches[paPitches.length - 1];
    if (!last) return { text: 'Undefined', color: '#888' };
    var kor = blank(last.KorBB) ? '' : String(last.KorBB).trim();
    if (kor === 'Strikeout') return { text: 'K', color: '#e63946' };
    if (kor === 'Walk') return { text: 'BB', color: '#2a9d8f' };
    if (isHitByPitch(last)) return { text: 'HBP', color: '#f4a261' };
    var pr = blank(last.PlayResult) ? '' : String(last.PlayResult).trim();
    if (pr === 'HomeRun' || pr === 'Home Run') return { text: 'HR', color: '#e63946' };
    if (pr === 'Triple') return { text: '3B', color: '#9b59b6' };
    if (pr === 'Double') return { text: '2B', color: '#2d5a8e' };
    if (pr === 'Single') return { text: '1B', color: '#2a9d8f' };
    if (pr && ['Out', 'FieldersChoice', 'Error', 'Sacrifice'].some(function (s) { return pr.indexOf(s) !== -1; })) {
      return { text: 'OUT', color: '#7a8faa' };
    }
    if (pr) return { text: pr, color: '#888' };
    return { text: 'Undefined', color: '#888' };
  }

  function pitcherLabel(paPitches) {
    var counts = Object.create(null);
    var names = [];
    (paPitches || []).forEach(function (r) {
      var name = (r.Pitcher || '').trim();
      if (!name) return;
      if (!counts[name]) { counts[name] = 0; names.push(name); }
      counts[name]++;
    });
    if (!names.length) return '—';
    var finalName = ((paPitches[paPitches.length - 1] || {}).Pitcher || '').trim();
    names.sort(function (a, b) {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      if (a === finalName) return -1;
      if (b === finalName) return 1;
      return 0;
    });
    var name = names[0];
    var last = (name.split(',')[0] || '').trim() || name;
    var hands = Object.create(null);
    var handNames = [];
    paPitches.forEach(function (r) {
      if ((r.Pitcher || '').trim() !== name) return;
      var hand = r.PitcherThrows;
      if (!hand) return;
      if (!hands[hand]) { hands[hand] = 0; handNames.push(hand); }
      hands[hand]++;
    });
    handNames.sort(function (a, b) { return hands[b] - hands[a]; });
    var tag = handNames[0] === 'Left' ? 'LHP' : handNames[0] === 'Right' ? 'RHP' : '';
    return tag ? last + ' (' + tag + ')' : last;
  }

  function callCode(r) {
    if (r.PitchCall === 'StrikeSwinging') return 'S';
    if (r.PitchCall === 'StrikeCalled') return 'CS';
    if (/^Foul/i.test(r.PitchCall || '')) return 'F';
    if (r.PitchCall === 'BallCalled' || r.PitchCall === 'Ball' || r.PitchCall === 'BallinDirt') return 'B';
    if (r.PitchCall === 'InPlay') return 'IP';
    if (r.PitchCall === 'HitByPitch') return 'HBP';
    return (r.PitchCall && r.PitchCall[0]) || '?';
  }

  function pitchSequence(paPitches) {
    return (paPitches || []).map(callCode).join('-');
  }

  return {
    groupPlateAppearances: groupPlateAppearances,
    paResult: paResult,
    pitcherLabel: pitcherLabel,
    callCode: callCode,
    pitchSequence: pitchSequence
  };
});
