// Identity and de-dupe for the Press Box stat sheet.
// The hitter-book summary table prints every hitting row on the selected
// team's sheet. Presto print PDFs (and a second stats file for the same
// team) often contain that table twice, with the same numbers. Cards are
// keyed by player, so only the table was doubling.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScoutPacket = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
  'use strict';

  // Same last|first-initial key the packet uses to join a stat row to Synergy.
  function keyOf(name) {
    name = String(name).replace(/\.+$/, '').trim();
    var last, first;
    if (name.indexOf(',') >= 0) {
      var p = name.split(',');
      last = p[0].trim();
      first = (p[1] || '').trim();
    } else {
      var t = name.split(/\s+/);
      last = t[t.length - 1];
      first = t.slice(0, -1).join(' ');
    }
    return (last + '|' + (first ? first[0] : '')).toLowerCase();
  }

  // PA = AB+BB+HBP+SF+SH. Matches the book; not AB alone.
  function hitterPA(s) {
    s = s || {};
    return (s.ab || 0) + (s.bb || 0) + (s.hbp || 0) + (s.sf || 0) + (s.sh || 0);
  }

  function hitterKey(s) {
    return String(s && s.num) + '|' + keyOf(s && s.name);
  }

  // One row per jersey + name. A later line replaces an earlier one only when
  // it has at least as many plate appearances, so a short conference split
  // cannot overwrite the official season line, and an identical duplicate
  // collapses to a single row.
  function dedupeHitters(rows) {
    var best = {};
    var order = [];
    (rows || []).forEach(function (s) {
      if (!s) return;
      var k = hitterKey(s);
      var prev = best[k];
      if (!prev) {
        best[k] = s;
        order.push(k);
        return;
      }
      if (hitterPA(s) >= hitterPA(prev)) best[k] = s;
    });
    return order.map(function (k) { return best[k]; });
  }

  return { keyOf: keyOf, hitterPA: hitterPA, dedupeHitters: dedupeHitters };
});
