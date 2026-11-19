import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import assert from "node:assert/strict";
import { prepareXliffDocument, exportXliffDocument, xliffExportIssues } from "../src/xliff-document.mjs";
import { runQa } from "../src/qa.mjs";

test("第 540 段：预检定位重复换行，修复后能写回，原有译文保留", () => {
  const filename = "sample.mqxliff";
  const xml = '<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2"><file><body><trans-unit id="540"><source>再開？<ph id="1">BR</ph>削除されます。</source><target/></trans-unit><trans-unit id="541"><source>既存</source><target>已有译文</target></trans-unit></body></file></xliff>';
  const bytes = Buffer.from(xml), parsed = prepareXliffDocument(bytes, filename);
  const segment = parsed.segments[0], tag = segment.source.match(/<tag[^>]+\/>/u)[0];
  const clean = "继续游戏吗？" + tag + "加载后会删除存档。";
  segment.translation = clean + "\n\n" + clean + tag;
  const [issue] = xliffExportIssues([segment]);
  assert.equal(issue.segmentId, segment.id);
  assert.match(issue.reason, /1.*3/u);
  assert.ok(runQa({ source: segment.source, translation: segment.translation }).some(i => i.type === "inline_tag_sequence"));
  assert.throws(() => exportXliffDocument({ filename, base64: bytes.toString("base64"), segments: [segment] }), /540/);
  segment.translation = clean;
  assert.deepEqual(xliffExportIssues([segment]), []);
  assert.match(exportXliffDocument({ filename, base64: bytes.toString("base64"), segments: [segment] }).toString(), /已有译文/);
});

test("Agent 仅能提交仍有问题的机器稿，保存后工作台导出使用新译文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kami-export-repair-")), cwd = join(dir, "workspace");
  const wb = await createWorkbench({ dataDirectory: join(dir, "data"), modelAdapter: async () => { throw Error("unexpected model call"); } });
  const { fs, close } = await workspaceFs(), context = { cwd, fs, human: true };
  try {
    await mkdir(cwd);
    const state = await wb.workspace({ action: "bind", name: "export-repair" }, context);
    const projectId = state.config.projectId, filename = "scope.mqxliff";
    await writeFile(join(cwd, filename), '<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2"><file><body><trans-unit id="540"><source>再開？<ph id="1">BR</ph>削除。</source><target/></trans-unit><trans-unit id="541"><source>保存。</source><target/></trans-unit></body></file></xliff>');
    const run = await wb.importFile({ path: filename, projectId }, context);
    const tag = run.segments[0].source.match(/<tag[^>]+\/>/u)[0], translation = "要继续吗？" + tag + "读取后删除。";
    const before = translation + translation + tag, batchId = run.batchId, path = `/api/batch/run/${batchId}/export-repair`;
    const segments = run.segments.map((s, i) => ({ ...s, status: "done", translation: i ? "保存。" : before }));
    await wb.invoke({ method: "POST", path: "/api/batch/run", body: { batchId, projectId, segments, runState: "completed" } }, context);
    const agent = { ...context, human: false };
    const get = () => wb.perform({ path: path + "?projectId=" + projectId }, agent);
    const submit = (more = {}) => wb.perform({ path, method: "POST", body: { batchId, projectId, segmentId: segments[0].id, before, translation, ...more } }, agent);
    for (const stage of ["context-brief", "consistency-check", "term-survey"]) {
      const retry = failedOnly => wb.perform({ path: `/api/batch/run/${batchId}/${stage}`, method: "POST", body: { projectId, failedOnly } }, context);
      await assert.rejects(retry("true"), /布尔值/);
      if (stage === "consistency-check") assert.equal((await retry(true)).count, 0);
      else await assert.rejects(retry(true), /没有可定位/);
    }
    const found = await get(); assert.deepEqual(found.issues.map(item => item.segmentId), [segments[0].id]);
    await assert.rejects(submit({ before: "旧版本" }), /变更/);
    await assert.rejects(submit({ segmentId: segments[1].id }), /已修复/);
    await assert.rejects(submit({ translation: "无标记" }), /标签/);
    assert.equal((await submit()).remaining, 0);
    await assert.rejects(submit(), /已修复/);
    assert.deepEqual((await get()).issues, []);
    const fixed = await wb.perform({ path: `/api/batch/run/${batchId}?projectId=${projectId}` }, agent);
    assert.equal(fixed.segments[0].result.exportRepair.reviewer, "Agent");
    assert.equal(fixed.segments[0].result.aiQa.used, false);
    const file = await wb.perform({ action: "export", batchId, projectId, mode: "writeback" }, context);
    const output = await readFile(file.path, "utf8");
    assert.match(output, /要继续吗？<ph id="1">BR<\/ph>读取后删除。/);
    assert.match(output, /<target[^>]*>保存。<\/target>/u);
  } finally { await wb.close(); await close(); await rm(dir, { recursive: true, force: true }); }
});
