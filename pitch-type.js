// Which pitch-type field the reports group on.
// Sean's tag is the call. TrackMan AutoPitchType fills in only when the tag
// is missing, blank, or the placeholder "Undefined". A real tag of "Other"
// stays Other. Display maps (Four-Seam -> Fastball, and so on) stay in each page.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PitchType = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isBlankType(value) {
    if (value === null || value === undefined) return true;
    var text = String(value).trim();
    return text === '' || text.toLowerCase() === 'undefined';
  }

  // resolvePitchType(tagged, auto) or resolvePitchType(pitchRow).
  // Returns the raw source string, trimmed. Empty when both sides are blank.
  function resolvePitchType(tagged, auto) {
    if (tagged !== null && typeof tagged === 'object') {
      auto = tagged.AutoPitchType;
      tagged = tagged.TaggedPitchType;
    }
    if (!isBlankType(tagged)) return String(tagged).trim();
    if (!isBlankType(auto)) return String(auto).trim();
    return '';
  }

  return {
    isBlankType: isBlankType,
    resolvePitchType: resolvePitchType
  };
});
