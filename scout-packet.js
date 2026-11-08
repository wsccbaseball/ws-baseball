// Identity, de-dupe, and cumulative stat-sheet parsing for Press Box.
// Presto print PDFs (dotted leaders, separate GP and GS, separate W and L)
// and Sidearm team cumulatives (plain rows, GP-GS and W-L combined, SB-ATT
// combined) both land here. One file may contain batting and pitching.
// Counting stats are taken from the sheet. This module does not grade ERA.
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

  // Baseball innings: .1 is one out, .2 is two outs. Used only to decide
  // which of two duplicate pitching lines is the longer outing.
  function ipOuts(ip) {
    var v = parseFloat(ip);
    if (isNaN(v)) return 0;
    var whole = Math.floor(v + 1e-9);
    var tenths = Math.round((v - whole) * 10);
    if (tenths === 1) return whole * 3 + 1;
    if (tenths === 2) return whole * 3 + 2;
    return whole * 3;
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

  function dedupePitchers(rows) {
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
      if (ipOuts(s.ip) >= ipOuts(prev.ip)) best[k] = s;
    });
    return order.map(function (k) { return best[k]; });
  }

  function dedupeCatchers(rows) {
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
      var attempts = (s.sba || 0) + (s.csb || 0);
      var prevAttempts = (prev.sba || 0) + (prev.csb || 0);
      if (attempts >= prevAttempts) best[k] = s;
    });
    return order.map(function (k) { return best[k]; });
  }

  function lineText(line) {
    return line.items.slice().sort(function (a, b) { return a.x - b.x; }).map(function (i) { return i.str; }).join(' ').replace(/[ \t]+/g, ' ').trim();
  }

  function itemWidth(it) {
    var w = it.w != null ? it.w : it.width;
    return w || 0;
  }

  // Group PDF.js text items into rows the same way the Press Box page does
  // (3px baseline). Sidearm then sometimes draws a wide ERA just above the
  // row and leaves the last digit of that ERA covered on the baseline
  // (Brae Gorman, 162.0). Reattach that raised number and drop only the
  // fragment it fully covers. Neighboring rows on a Presto sheet sit about
  // 9px apart, so the 3px grouping itself stays put.
  function buildViews(items) {
    var s = (items || []).slice().sort(function (a, b) { return b.y - a.y; });
    var lines = [];
    var cur = null;
    s.forEach(function (it) {
      if (!cur || Math.abs(it.y - cur.y) > 3) {
        cur = { y: it.y, items: [it] };
        lines.push(cur);
      } else cur.items.push(it);
    });
    lines.forEach(function (line, i) {
      var vis = lineText(line);
      if (!/^[0-9]+\.[0-9]+$/.test(vis)) return;
      var best = -1;
      var bestGap = 12;
      for (var j = 0; j < lines.length; j++) {
        if (j === i) continue;
        var gap = Math.abs(lines[j].y - line.y);
        if (gap < bestGap && /[A-Za-z]/.test(lineText(lines[j]))) {
          best = j;
          bestGap = gap;
        }
      }
      if (best < 0) return;
      var orphan = null;
      line.items.forEach(function (it) { if (String(it.str).trim()) orphan = it; });
      if (!orphan) return;
      var ox2 = orphan.x + itemWidth(orphan);
      lines[best].items = lines[best].items.filter(function (it) {
        var str = String(it.str).trim();
        if (!str) return true;
        var ix2 = it.x + itemWidth(it);
        var overlaps = orphan.x < ix2 - 0.4 && it.x < ox2 - 0.4;
        if (!overlaps) return true;
        var covered = it.x >= orphan.x - 0.6 && ix2 <= ox2 + 0.6;
        return !covered;
      });
      lines[best].items.push(orphan);
      line.items = [];
    });
    var rowText = lines.map(lineText).filter(function (t) { return t.length; }).join('\n');
    var rawText = (items || []).map(function (it) { return 'x' + Math.round(it.x) + ' y' + Math.round(it.y) + '  ' + it.str; }).join('\n');
    return { rowText: rowText, rawText: rawText };
  }

  var HIT = {
    'AVG': 'avg', 'GP-GS': 'gpgs', 'GP': 'gp', 'GS': 'gs', 'AB': 'ab', 'R': 'r', 'H': 'h',
    '2B': 'db', '3B': 't3', 'HR': 'hr', 'RBI': 'rbi', 'TB': 'tb', 'SLG%': 'slg', 'SLG': 'slg',
    'BB': 'bb', 'HBP': 'hbp', 'SO': 'k', 'K': 'k', 'GDP': 'gdp', 'GIDP': 'gdp',
    'OB%': 'obp', 'OBP': 'obp', 'SF': 'sf', 'SH': 'sh', 'SB-ATT': 'sbatt', 'SB': 'sb', 'CS': 'cs'
  };
  var PIT = {
    'ERA': 'era', 'W-L': 'wl', 'W': 'w', 'L': 'l', 'APP': 'app', 'GS': 'gs', 'CG': 'cg',
    'SHO': 'sho', 'SV': 'sv', 'IP': 'ip', 'H': 'h', 'R': 'r', 'ER': 'er', 'BB': 'bb',
    'SO': 'k', 'K': 'k', '2B': 'd2', '3B': 't3', 'HR': 'hr', 'AB': 'ab', 'B/AVG': 'baa',
    'WP': 'wp', 'HBP': 'hbp', 'HP': 'hbp', 'BK': 'bk', 'SFA': 'sfa', 'SHA': 'sha'
  };
  var FLD = {
    'C': 'c', 'PO': 'po', 'A': 'a', 'E': 'e', 'FLD%': 'fld', 'DP': 'dp',
    'SBA': 'sba', 'CSB': 'csb', 'PB': 'pb', 'CI': 'ci'
  };

  function numv(x) {
    if (x === '-' || x === '—' || x === '–' || x === '' || x == null) return 0;
    var s = String(x);
    if (s.indexOf('.') >= 0) {
      var f = parseFloat(s);
      return isNaN(f) ? 0 : f;
    }
    var n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  }

  function isStatTok(t) {
    return /^(?:-|\u2013|\u2014|\.\d+|\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)$/.test(t);
  }

  function pair(tok) {
    var m = String(tok).match(/^(\d+)-(\d+)$/);
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10)];
  }

  function has(cell, key) {
    return !!cell && Object.prototype.hasOwnProperty.call(cell, key) && cell[key] != null && cell[key] !== '';
  }

  function headerTable(mode) {
    if (mode === 'p') return PIT;
    if (mode === 'f') return FLD;
    return HIT;
  }

  function parseHeader(ln) {
    var s = ln.replace(/\s+/g, ' ').trim();
    var m = s.match(/^(?:#|No\.?)\s+Player\s+(.+)$/i);
    if (!m && (/^Player\s+(?:AVG|ERA)\b/i.test(s) || /\bFLD%/.test(s) || /Player\s+G\s+TC\b/i.test(s))) {
      var pm = s.match(/Player\s+(.+)$/i);
      if (pm) m = pm;
    }
    if (!m) return null;
    var cols = m[1].split(/\s+/).filter(Boolean);
    var first = (cols[0] || '').toUpperCase();
    var mode = null;
    if (first === 'ERA') mode = 'p';
    else if (first === 'AVG') mode = 'h';
    else if (cols.some(function (c) { return /FLD%/i.test(c); })) mode = 'f';
    return { mode: mode, cols: cols };
  }

  function zip(cols, stats, mode) {
    if (!cols || stats.length !== cols.length) return null;
    var table = headerTable(mode);
    var out = {};
    for (var i = 0; i < cols.length; i++) {
      var key = table[String(cols[i]).toUpperCase()];
      if (!key) continue;
      out[key] = stats[i];
    }
    return out;
  }

  function splitPlayerLine(ln) {
    var m = String(ln).match(/^(\d+)\s+(.+)$/);
    if (!m) return null;
    var num = m[1];
    var rest = m[2];
    if (/\.{2,}/.test(rest)) {
      var d = rest.match(/^(.*?)\.{2,}\s*(.*)$/);
      if (d && d[2] && isStatTok(d[2].split(/\s+/)[0])) {
        return { num: num, name: d[1].trim(), stats: d[2].split(/\s+/).filter(Boolean) };
      }
    }
    var toks = rest.split(/\s+/).filter(Boolean);
    var nameToks = [];
    var i = 0;
    while (i < toks.length && !isStatTok(toks[i])) {
      nameToks.push(toks[i]);
      i++;
    }
    if (!nameToks.length || i >= toks.length) return null;
    return { num: num, name: nameToks.join(' '), stats: toks.slice(i) };
  }

  function totalsKind(ln) {
    var m = String(ln).match(/^(Totals?|Opponents)\b(.*)$/i);
    if (!m) return null;
    var toks = m[2].replace(/\.{2,}/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!toks.length || !isStatTok(toks[0])) return null;
    return { kind: /^opp/i.test(m[1]) ? 'opp' : 'team', stats: toks };
  }

  function hittingStats(cell) {
    if (!has(cell, 'avg') || !has(cell, 'ab') || !has(cell, 'h') || !has(cell, 'hr')) return null;
    if (!has(cell, 'slg') || !has(cell, 'obp') || !has(cell, 'bb') || !has(cell, 'k')) return null;
    if (!has(cell, 'sb') && !has(cell, 'sbatt')) return null;
    var gp = null;
    var gs = null;
    if (has(cell, 'gpgs')) {
      var g = pair(cell.gpgs);
      if (g) { gp = g[0]; gs = g[1]; }
      else gp = numv(cell.gpgs);
    } else {
      if (has(cell, 'gp')) gp = numv(cell.gp);
      if (has(cell, 'gs')) gs = numv(cell.gs);
    }
    var sb;
    if (has(cell, 'sbatt')) {
      var s = pair(cell.sbatt);
      sb = s ? s[0] : numv(cell.sbatt);
    } else sb = numv(cell.sb);
    return {
      avg: cell.avg,
      ab: numv(cell.ab),
      h: numv(cell.h),
      db: has(cell, 'db') ? numv(cell.db) : 0,
      hr: numv(cell.hr),
      slg: cell.slg,
      bb: numv(cell.bb),
      hbp: has(cell, 'hbp') ? numv(cell.hbp) : 0,
      k: numv(cell.k),
      gdp: has(cell, 'gdp') ? numv(cell.gdp) : 0,
      obp: cell.obp,
      sf: has(cell, 'sf') ? numv(cell.sf) : 0,
      sh: has(cell, 'sh') ? numv(cell.sh) : 0,
      sb: sb,
      gp: gp,
      gs: gs
    };
  }

  function pitchingStats(cell) {
    if (!has(cell, 'era') || !has(cell, 'ip') || !has(cell, 'baa')) return null;
    if (!has(cell, 'k') || !has(cell, 'bb') || !has(cell, 'hr')) return null;
    if (!has(cell, 'app') || !has(cell, 'gs') || !has(cell, 'sv')) return null;
    var w;
    var l;
    if (has(cell, 'wl')) {
      var p = pair(cell.wl);
      if (!p) return null;
      w = p[0];
      l = p[1];
    } else if (has(cell, 'w') && has(cell, 'l')) {
      w = numv(cell.w);
      l = numv(cell.l);
    } else return null;
    return {
      era: cell.era,
      w: w,
      l: l,
      app: numv(cell.app),
      gs: numv(cell.gs),
      sv: numv(cell.sv),
      ip: cell.ip,
      k: numv(cell.k),
      bb: numv(cell.bb),
      hr: numv(cell.hr),
      baa: cell.baa,
      wp: has(cell, 'wp') ? numv(cell.wp) : 0,
      hbp: has(cell, 'hbp') ? numv(cell.hbp) : 0
    };
  }

  // A lone decimal on its own line is the raised Sidearm cell. The next
  // player row still has the covered last digit where that cell should be.
  function reattachRaisedLines(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var nxt = lines[i + 1];
      if (/^[0-9]+\.[0-9]+$/.test(ln) && nxt && /^\d+\s+\S/.test(nxt)) {
        var player = splitPlayerLine(nxt);
        if (player && player.stats.length) {
          var stats = player.stats.slice();
          var first = stats[0];
          if (first !== ln && ln.charAt(ln.length - 1) === first && first.length === 1 && /^\d$/.test(first)) {
            stats = stats.slice(1);
          }
          stats.unshift(ln);
          out.push(player.num + ' ' + player.name + ' ' + stats.join(' '));
          i++;
          continue;
        }
      }
      out.push(ln);
    }
    return out;
  }

  function parseStatSheet(rowsText) {
    var lines = reattachRaisedLines(String(rowsText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n'));
    var hit = [];
    var pit = [];
    var cat = [];
    var team = null;
    var season = null;
    var asOf = null;
    var record = null;
    var confRecord = null;
    var mode = null;
    var cols = null;
    var totH = null;
    var totP = null;
    var sawTable = false;
    var skipped = 0;
    lines.forEach(function (ln) {
      if (!ln || !String(ln).trim()) return;
      if (/^===\s+PAGE\b/.test(ln)) return;
      if (!team) {
        var presto = ln.match(/Baseball Statistics\s*-\s*(.+?)(?:\s*-\s*Official|\s*$)/);
        if (presto) team = presto[1].trim();
      }
      if (!team) {
        var side = ln.match(/^(?:19|20)\d{2}\s+(.+?)\s+Baseball\s*$/);
        if (side) team = side[1].trim();
      }
      if (!season) {
        var sy = ln.match(/^((?:19|20)\d{2}(?:-\d{2})?)\b.*\bBaseball\b/);
        if (sy) season = sy[1];
      }
      if (!asOf) {
        var ao = ln.match(/\bas of\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
        if (ao) asOf = ao[1];
      }
      if (!record) {
        var rm = ln.match(/\bRecord:\s*(\d+)\s*-\s*(\d+)/);
        if (rm) record = rm[1] + '-' + rm[2];
      }
      if (!confRecord) {
        var cm = ln.match(/\bConf:\s*(\d+)\s*-\s*(\d+)/);
        if (cm) confRecord = cm[1] + '-' + cm[2];
      }
      var header = parseHeader(ln);
      if (header) {
        mode = header.mode;
        cols = header.cols;
        if (mode === 'h' || mode === 'p') sawTable = true;
        return;
      }
      if (mode !== 'h' && mode !== 'p' && mode !== 'f') return;
      var total = totalsKind(ln);
      if (total) {
        if (total.kind === 'team' && (mode === 'h' || mode === 'p')) {
          var tcell = zip(cols, total.stats, mode);
          var tstats = tcell && (mode === 'h' ? hittingStats(tcell) : pitchingStats(tcell));
          if (tstats) {
            if (mode === 'h') totH = tstats;
            else totP = tstats;
          } else skipped++;
        }
        return;
      }
      var player = splitPlayerLine(ln);
      if (!player) return;
      var cell = zip(cols, player.stats, mode);
      if (!cell) { skipped++; return; }
      if (mode === 'h') {
        var hs = hittingStats(cell);
        if (!hs) { skipped++; return; }
        hs.num = player.num;
        hs.name = player.name;
        hit.push(hs);
      } else if (mode === 'p') {
        var ps = pitchingStats(cell);
        if (!ps) { skipped++; return; }
        ps.num = player.num;
        ps.name = player.name;
        pit.push(ps);
      } else if (mode === 'f' && (has(cell, 'sba') || has(cell, 'csb'))) {
        var sba = has(cell, 'sba') ? numv(cell.sba) : 0;
        var csb = has(cell, 'csb') ? numv(cell.csb) : 0;
        if (sba || csb) cat.push({ num: player.num, name: player.name, sba: sba, csb: csb });
      }
    });
    return {
      team: team,
      season: season,
      asOf: asOf,
      record: record,
      confRecord: confRecord,
      hit: hit,
      pit: pit,
      cat: cat,
      totH: totH,
      totP: totP,
      sawTable: sawTable,
      skipped: skipped
    };
  }

  function blankTeam(name) {
    return {
      team: name, hit: [], pit: [], cat: [], totH: null, totP: null, record: null,
      season: null, confRecord: null, asOf: null
    };
  }

  // Merge every cumulative that actually produced players. The same team
  // uploaded twice, or the same table printed twice inside one PDF, collapses
  // by jersey and name. A sheet with no players is left out so it cannot
  // show up as an empty successful team.
  function assembleStatTeams(entries) {
    var byTeam = {};
    var idx = 0;
    (entries || []).forEach(function (e) {
      var s = e && e.hit ? e : parseStatSheet(e && e.rowsText || '');
      if (!((s.hit && s.hit.length) || (s.pit && s.pit.length))) return;
      var name = s.team || ('Sheet ' + (++idx));
      var t = byTeam[name] || (byTeam[name] = blankTeam(name));
      t.hit = t.hit.concat(s.hit || []);
      t.pit = t.pit.concat(s.pit || []);
      t.cat = t.cat.concat(s.cat || []);
      t.totH = t.totH || s.totH || null;
      t.totP = t.totP || s.totP || null;
      t.record = t.record || s.record || null;
      t.season = t.season || s.season || null;
      t.confRecord = t.confRecord || s.confRecord || null;
      t.asOf = t.asOf || s.asOf || null;
    });
    return Object.keys(byTeam).map(function (k) {
      var t = byTeam[k];
      t.hit = dedupeHitters(t.hit);
      t.pit = dedupePitchers(t.pit);
      t.cat = dedupeCatchers(t.cat);
      return t;
    });
  }

  function statSheetProblem(parsed) {
    var hitN = parsed && parsed.hit ? parsed.hit.length : 0;
    var pitN = parsed && parsed.pit ? parsed.pit.length : 0;
    if (hitN + pitN > 0) return '';
    if (parsed && parsed.sawTable) {
      return 'A batting or pitching table was found, but no player rows were read. Download the official team cumulative again and re-upload that PDF, or paste the cumulative table below.';
    }
    return 'No hitters or pitchers were read. Upload the official team cumulative PDF (a Presto print sheet or a Sidearm cumulative such as the Murray State College baseball stats PDF). Batting and pitching can be in the same file. A roster or a blank export will not fill the books — or paste the cumulative table below.';
  }

  // Same keyword sort the page has always used. Kept here so both copies of
  // the builder and the tests share one classifier.
  function classifyUpload(text) {
    var t = (text || '').toLowerCase();
    function hits(ws) { var n = 0; for (var i = 0; i < ws.length; i++) if (t.indexOf(ws[i]) >= 0) n++; return n; }
    var common = hits(['fastball', 'slider', 'curveball', 'changeup', 'sinker', 'cutter', 'whiff', 'chase', 'synergy', 'heat map', 'spray', 'swing %', 'put away']);
    var pit = hits([' ip ', 'era', 'k/9', 'bb/9', 'whip', 'velocity', 'velo', 'release', 'vs rhh', 'vs lhh', 'innings', 'pitch count', 'strikeouts', 'pitcher:']);
    var hit = hits(['vs rhp', 'vs lhp', 'at bat', 'at-bat', 'plate appearance', 'exit velo', 'bip', 'hitter:']);
    var ros = hits(['bats/throws', 'b/t', 'roster', 'height', 'weight', 'class', 'jersey', 'hometown', ' fr ', ' so ', ' jr ', ' sr ']);
    var sta = hits(['avg', 'obp', 'slg', 'ops', ' ab ', ' rbi', ' hr ', 'batting', 'hitting statistics', 'totals', ' gp ', ' gs ', 'at bats', 'overall statistics']);
    if (common >= 2) {
      if (t.indexOf('hitter:') >= 0) return { type: 'synergyHit', conf: common };
      if (t.indexOf('pitcher:') >= 0) return { type: 'synergyPit', conf: common };
      return { type: (pit > hit ? 'synergyPit' : 'synergyHit'), conf: common };
    }
    if (ros >= 2 && ros >= sta) return { type: 'roster', conf: ros };
    if (sta >= 2) return { type: 'stats', conf: sta };
    return { type: 'unknown', conf: 0 };
  }

  return {
    keyOf: keyOf,
    hitterPA: hitterPA,
    dedupeHitters: dedupeHitters,
    dedupePitchers: dedupePitchers,
    dedupeCatchers: dedupeCatchers,
    ipOuts: ipOuts,
    buildViews: buildViews,
    parseStatSheet: parseStatSheet,
    assembleStatTeams: assembleStatTeams,
    statSheetProblem: statSheetProblem,
    classifyUpload: classifyUpload
  };
});
