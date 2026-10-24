import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResourceLibraryCompiler, libraryResource } from "../src/resource-library-compilation.mjs";

test("one library file merges selected updates, deduplicates pairs, preserves alternatives and source notes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-library-compile-"));
  try {
    const compiler = createResourceLibraryCompiler(directory), group = { workspace: "workspace", projectId: "project", purpose: "tm", libraryId: "library" };
    const a = { path: "a.xlsx", hash: "a".repeat(64) }, b = { path: "b.xlsx", hash: "b".repeat(64) };
    const pair = { source: "設定を開く", target: "打开设置", context: "UI" };
    await compiler.update(group, [{ source: a, parsed: { candidates: [{ ...pair, note: "来源甲" }, { source: "未選択", target: "未选中" }] } }]);
    const merged = await compiler.update(group, [{ source: b, parsed: { candidates: [{ ...pair, note: "来源乙" }, { ...pair, target: "开启设置" }, { ...pair, context: "其他场景" }] } }]);
    assert.equal(merged.candidates.length, 4);
    assert.equal(merged.duplicateCount, 1);
    const shared = merged.candidates.find((item) => item.source === pair.source && item.target === pair.target && item.context === "UI");
    assert.deepEqual(shared.sourceFiles, [a.path, b.path]);
    assert.equal(shared.note, "来源甲\n来源乙");
    const next = await compiler.update(group, [{ source: { ...b, hash: "c".repeat(64) }, parsed: { candidates: [{ source: "変更", target: "改动" }] } }]);
    assert.equal(next.candidates.length, 3);
    assert.equal(next.candidates.find((item) => item.source === pair.source).note, "来源甲");
    assert.equal(libraryResource(next, a).candidates.length, 2);
    assert.equal(libraryResource(next, b), null, "old source versions cannot use a replacement contribution");
    assert.equal((await readdir(join(directory, "runtime/compiled-resources"))).length, 1);
    assert.equal(JSON.parse(await readFile(compiler.path(group), "utf8")).sources.length, 2);
    const other = { ...group, libraryId: "other" };
    assert.equal(await compiler.read(other), null, "independent libraries must not share compiled content");
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "kami-library-compile-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("large source updates merge without hitting JavaScript argument limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-library-large-"));
  try {
    const compiler = createResourceLibraryCompiler(directory), group = { workspace: "workspace", projectId: "project", purpose: "tm", libraryId: "large" };
    const source = { path: "large.xlsx", hash: "a".repeat(64) };
    const record = await compiler.update(group, [{ source, parsed: { candidates: Array(150000).fill({ source: "共通", target: "共用" }) } }]);
    assert.equal(record.candidates.length, 1);
    assert.equal(record.duplicateCount, 149999);
    assert.equal(libraryResource(record, source).candidates.length, 1);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "kami-library-large-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent incremental writes retain all sources and styles update without replacing unselected rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-library-concurrent-"));
  try {
    const compiler = createResourceLibraryCompiler(directory), group = { workspace: "workspace", projectId: "project", purpose: "terms", libraryId: "terms" };
    await Promise.all(Array.from({ length: 12 }, (_, index) => compiler.update(group, [{ source: { path: `${index}.xlsx`, hash: String(index).padStart(64, "0") }, parsed: { candidates: [{ source: "共通", target: "共用" }, { source: `用語${index}`, target: `词条${index}` }] } }])));
    const record = await compiler.read(group);
    assert.equal(record.sources.length, 12); assert.equal(record.candidates.length, 13);
    assert.equal(record.candidates.find((item) => item.source === "共通").sourceFiles.length, 12);
    const style = { ...group, purpose: "style-guide", libraryId: "" }, a = { path: "a.docx", hash: "a".repeat(64) }, b = { path: "b.pdf", hash: "b".repeat(64) };
    await compiler.update(style, [{ source: a, parsed: { text: "保留第一份规范。" } }, { source: b, parsed: { text: "第二份规范与例外。" } }]);
    const updated = await compiler.update(style, [{ source: { ...b, hash: "c".repeat(64) }, parsed: { text: "更新第二份规范。" } }]);
    assert.equal(updated.guides.length, 2);
    assert.equal(libraryResource(updated, a).text, "保留第一份规范。");
    assert.equal(libraryResource(updated, b), null);
    const repeated = await compiler.update(style, [{ source: { path: "copy.docx", hash: "d".repeat(64) }, parsed: { text: "保留第一份规范。" } }]);
    assert.equal(repeated.guides.length, 2); assert.equal(repeated.sources.length, 3); assert.equal(repeated.duplicateCount, 1);
    assert.equal((await readdir(join(directory, "runtime/compiled-resources"))).length, 2);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "kami-library-concurrent-")));
    await rm(directory, { recursive: true, force: true });
  }
});
