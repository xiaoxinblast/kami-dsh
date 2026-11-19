import { comparableText } from "./asset-governance.mjs";

// 按本轮待查词建立前缀树。每个 TM 原文只正规化一次，同一条译例可命中多个词。
export function indexSurveyMemories(sources, libraries, rows) {
  const bySource = new Map(sources.map(source => [source, []]));
  const enabled = new Map(libraries.filter(lib => lib.enabled !== false && ["master", "reference"].includes(lib.role)).map(lib => [lib.id, lib]));
  const root = new Map();
  for (const source of bySource.keys()) {
    const needle = comparableText(source);
    if (!needle) continue;
    let node = root;
    for (const char of needle) {
      if (!node.has(char)) node.set(char, new Map());
      node = node.get(char);
    }
    node.set(null, [...(node.get(null) || []), source]);
  }
  for (const row of rows) {
    const lib = enabled.get(row.linkedLibraryId || row.libraryId);
    if (!lib || !row.target) continue;
    const chars = [...comparableText(row.source)], found = new Set();
    for (let i = 0; i < chars.length; i++) {
      let node = root;
      for (let j = i; j < chars.length && (node = node.get(chars[j])); j++) {
        for (const source of node.get(null) || []) found.add(source);
      }
    }
    if (!found.size) continue;
    const entry = { id: row.id, source: row.source, target: row.target, sourceFile: row.sourceFiles?.join("、") || row.resourcePath || row.sourceFile,
      libraryId: lib.id, libraryName: lib.name, libraryRole: lib.role };
    for (const source of found) bySource.get(source).push(entry);
  }
  return bySource;
}
