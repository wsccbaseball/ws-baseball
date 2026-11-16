/* Knowledge search shared by hq/index.html and tested in knowledge-search.test.js.
   The same rules are implemented in SQL by hq_search_knowledge
   (hq/migrations/20261116183000_hq_knowledge_search.sql):

   - Trim the query, strip LIKE wildcards (% _ \), and keep the first 80 characters.
   - Match case-insensitively across summary, source_text, and tags.
   - Treat spaces and hyphens as the same separator, so "pop time" matches "pop-time".
   - A selected tag is an exact tag match on top of the text query.
   - Page size is 25, newest created_at first, id as a tie-break.
*/
(function (root) {
  var PAGE_SIZE = 25;
  var CHIP_LIMIT = 18;
  var QUERY_LIMIT = 80;

  function cleanQuery(q) {
    return String(q || '').trim().replace(/[%_\\]/g, '').trim().slice(0, QUERY_LIMIT);
  }

  function searchVariants(q) {
    var cleaned = cleanQuery(q);
    if (!cleaned) return [];
    var variants = [cleaned];
    if (/[\s-]/.test(cleaned)) {
      variants.push(cleaned.replace(/[\s-]+/g, ' ').replace(/\s+/g, ' ').trim());
      variants.push(cleaned.replace(/[\s-]+/g, '-'));
    }
    var seen = {};
    var out = [];
    variants.forEach(function (variant) {
      var value = String(variant || '').trim();
      if (!value || seen[value]) return;
      seen[value] = true;
      out.push(value);
    });
    return out;
  }

  function postgrestQuote(value) {
    return '"' + String(value).replace(/"/g, '""') + '"';
  }

  function tagContainsFilter(tag) {
    return '{' + postgrestQuote(tag) + '}';
  }

  function matchingTags(tagNames, q) {
    var needles = searchVariants(q).map(function (variant) { return variant.toLowerCase(); });
    if (!needles.length) return [];
    var seen = {};
    var out = [];
    (tagNames || []).forEach(function (tag) {
      var name = String(tag || '').trim();
      if (!name || seen[name]) return;
      var lower = name.toLowerCase();
      var hit = needles.some(function (needle) { return lower.indexOf(needle) !== -1; });
      if (!hit) return;
      seen[name] = true;
      out.push(name);
    });
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  function knowledgeOrFilter(q, tagNames) {
    var variants = searchVariants(q);
    if (!variants.length) return '';
    var parts = [];
    variants.forEach(function (variant) {
      var quoted = postgrestQuote('%' + variant + '%');
      parts.push('summary.ilike.' + quoted);
      parts.push('source_text.ilike.' + quoted);
    });
    matchingTags(tagNames, q).forEach(function (tag) {
      parts.push('tags.cs.{' + postgrestQuote(tag) + '}');
    });
    return parts.join(',');
  }

  function tallyTags(rows) {
    var counts = new Map();
    (rows || []).forEach(function (row) {
      var tags = row && Array.isArray(row.tags) ? row.tags : [];
      tags.forEach(function (tag) {
        var name = String(tag || '').trim();
        if (!name) return;
        counts.set(name, (counts.get(name) || 0) + 1);
      });
    });
    return Array.from(counts.entries()).map(function (entry) {
      return { tag: entry[0], count: entry[1] };
    }).sort(function (a, b) {
      return b.count - a.count || a.tag.localeCompare(b.tag);
    });
  }

  function chipTags(tallied, limit, selected) {
    var cap = limit || CHIP_LIMIT;
    var top = (tallied || []).slice(0, cap);
    if (selected && !top.some(function (chip) { return chip.tag === selected; })) {
      var found = (tallied || []).find(function (chip) { return chip.tag === selected; });
      top.push(found || { tag: selected, count: 0 });
    }
    return top;
  }

  function noteCountLabel(total) {
    if (total == null || total === '') return 'Searching…';
    var n = Number(total);
    if (!Number.isFinite(n)) return 'Searching…';
    return n === 1 ? '1 note' : (n + ' notes');
  }

  function normalizeKnowledgeResult(data) {
    var payload = data;
    if (typeof payload === 'string') payload = JSON.parse(payload);
    payload = payload || {};
    var items = Array.isArray(payload.items) ? payload.items : [];
    var total = Number(payload.total);
    return {
      items: items,
      total: Number.isFinite(total) ? total : items.length,
    };
  }

  function isMissingKnowledgeRpc(error) {
    if (!error) return false;
    var code = String(error.code || '');
    var msg = String(error.message || error.details || '');
    if (code === 'PGRST202' || code === '42883') return true;
    return /hq_search_knowledge/i.test(msg) && /(schema cache|does not exist|could not find)/i.test(msg);
  }

  root.WSKnowledgeSearch = {
    PAGE_SIZE: PAGE_SIZE,
    CHIP_LIMIT: CHIP_LIMIT,
    cleanQuery: cleanQuery,
    searchVariants: searchVariants,
    postgrestQuote: postgrestQuote,
    tagContainsFilter: tagContainsFilter,
    matchingTags: matchingTags,
    knowledgeOrFilter: knowledgeOrFilter,
    tallyTags: tallyTags,
    chipTags: chipTags,
    noteCountLabel: noteCountLabel,
    normalizeKnowledgeResult: normalizeKnowledgeResult,
    isMissingKnowledgeRpc: isMissingKnowledgeRpc,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
