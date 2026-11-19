import { checkLineLayout } from "./line-layout.mjs";

// Only strip serialized layout. Numbers, variables, ordinary punctuation and names remain wording.
const layout = /<tag\s+[^<>]*?\/>|<br\s*\/?>|\r\n|[\r\n]/giu;
const inline = /^<tag\s/iu;
const fixedTokens = text => String(text ?? "").match(/<tag\s+[^<>]*?\/>|<br\s*\/?>/giu) || [];
export const visibleWording = (text) => String(text ?? "").replace(layout, "");

export function compareBenchmarkStructure(source, translation, lineBreakMarkers = [], rules = []) {
  const differences = new Map();
  for (const [text, sign] of [[source, 1], [translation, -1]]) {
    for (const token of fixedTokens(text)) {
      differences.set(token, (differences.get(token) || 0) + sign);
    }
  }
  const result = { missingLineBreaks: 0, extraLineBreaks: 0, missingInline: 0, extraInline: 0 };
  for (const [token, delta] of differences) {
    const kind = !inline.test(token) || lineBreakMarkers.includes(token) ? "LineBreaks" : "Inline";
    result[(delta > 0 ? "missing" : "extra") + kind] += Math.abs(delta);
  }
  if (!Object.values(result).some(Boolean)) {
    const actual = fixedTokens(translation);
    if (fixedTokens(source).some((token, index) => token !== actual[index])) result.outOfOrder = 1;
    for (const marker of lineBreakMarkers) {
      const [before, after] = String(source).split(marker);
      const [left, right] = String(translation).split(marker);
      if (visibleWording(before).trim() && visibleWording(after).trim() && (!visibleWording(left).trim() || !visibleWording(right).trim())) {
        result.misplacedBreaks = (result.misplacedBreaks || 0) + 1;
      }
    }
  }
  const duplicateBreaks = extraBreaksBesideMarker(source, translation, lineBreakMarkers);
  result.extraLineBreaks += duplicateBreaks;
  const constraints = checkLineLayout(translation, { markers: lineBreakMarkers, rules }).filter(issue => issue.type !== "line_layout_marker");
  if (constraints.length) result.layoutViolations = constraints.length;
  return result;
}

// A serialized break already creates a line break on export. Count surplus physical breaks
// touching such a marker, excluding physical breaks also present in the source.
export function extraBreaksBesideMarker(source, translation, markers = []) {
  const expected = fixedTokens(source);
  const actual = fixedTokens(translation);
  // A duplicated or missing fixed token already has its own fault.
  markers = [...new Set([...markers, ...expected.filter(token => !inline.test(token))])].filter(marker =>
    expected.filter(t => t === marker).length === actual.filter(t => t === marker).length);
  if (!markers.length) return 0;
  // Compare adjacency at each fixed marker, independently of natural wrapping elsewhere.
  const adjacent = (text) => {
    const counts = new Map();
    const parts = String(text).split(/(\r\n|\r|\n)/u);
    for (let i = 1; i < parts.length; i += 2) {
      const marker = markers.find(m => parts[i - 1].endsWith(m) || parts[i + 1].startsWith(m));
      if (marker) counts.set(marker, (counts.get(marker) || 0) + 1);
    }
    return counts;
  };
  const before = adjacent(source);
  let extra = 0;
  for (const [marker, count] of adjacent(translation)) extra += Math.max(0, count - (before.get(marker) || 0));
  return extra;
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
