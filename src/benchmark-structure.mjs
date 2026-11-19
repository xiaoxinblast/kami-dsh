// Only strip serialized layout. Numbers, variables, ordinary punctuation and names remain wording.
const layout = /<tag\s+[^<>]*?\/>|<br\s*\/?>|\r\n|[\r\n]/giu;
const inline = /^<tag\s/iu;
export const visibleWording = (text) => String(text ?? "").replace(layout, "");

export function compareBenchmarkStructure(source, translation, lineBreakMarkers = []) {
  const differences = new Map();
  for (const [text, sign] of [[source, 1], [translation, -1]]) {
    for (let token of String(text ?? "").match(layout) || []) {
      if (/^[\r\n]+$/u.test(token)) token = "\n";
      differences.set(token, (differences.get(token) || 0) + sign);
    }
  }
  const result = { missingLineBreaks: 0, extraLineBreaks: 0, missingInline: 0, extraInline: 0 };
  for (const [token, delta] of differences) {
    const kind = !inline.test(token) || lineBreakMarkers.includes(token) ? "LineBreaks" : "Inline";
    result[(delta > 0 ? "missing" : "extra") + kind] += Math.abs(delta);
  }
  if (!Object.values(result).some(Boolean)) {
    const tokens = text => (String(text ?? "").match(layout) || []).map(token => token.replace(/\r\n?/gu, "\n"));
    const actual = tokens(translation);
    if (tokens(source).some((token, index) => token !== actual[index])) result.outOfOrder = 1;
    for (const marker of lineBreakMarkers) {
      const [before, after] = String(source).split(marker);
      const [left, right] = String(translation).split(marker);
      if (visibleWording(before).trim() && visibleWording(after).trim() && (!visibleWording(left).trim() || !visibleWording(right).trim())) {
        result.misplacedBreaks = (result.misplacedBreaks || 0) + 1;
      }
    }
  }
  return result;
}

// A serialized break already creates a line break on export. Count surplus physical breaks
// touching such a marker, excluding physical breaks also present in the source.
export function extraBreaksBesideMarker(source, translation, markers, extraLineBreaks) {
  if (!extraLineBreaks || !markers?.length) return 0;
  const adjacent = (text) => {
    const parts = String(text).split(/(\r\n|\r|\n)/u);
    return parts.filter((part, i) => i % 2 && markers.some((marker) =>
      parts[i - 1].endsWith(marker) || parts[i + 1].startsWith(marker))).length;
  };
  return Math.min(extraLineBreaks, Math.max(0, adjacent(translation) - adjacent(source)));
}

export function summarizeStructure(samples) {
  const rounds = new Map();
  for (const sample of samples) {
    if (!sample.structure) continue;
    const repetition = (sample.repetition || 0) + 1;
    if (!rounds.has(repetition)) rounds.set(repetition, { repetition, draws: 0, repairedDraws: 0, attemptedRepairs: 0, extraPhysicalBreaksBesideMarker: 0, first: {}, final: {} });
    const round = rounds.get(repetition);
    round.draws++;
    round.extraPhysicalBreaksBesideMarker += sample.structure.extraPhysicalBreaksBesideMarker || 0;
    if (sample.structure.retry) {
      round.attemptedRepairs++;
      if (!Object.values(sample.structure.final).some(Boolean)) round.repairedDraws++;
    }
    for (const stage of ["first", "final"]) {
      for (const [kind, value] of Object.entries(sample.structure[stage])) round[stage][kind] = (round[stage][kind] || 0) + value;
    }
  }
  return [...rounds.values()].sort((left, right) => left.repetition - right.repetition);
}
