import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { batchReferenceEvidence } from "../dsh/reference-evidence.mjs";
import { translateWithReflection, proofreadTranslationWithModel, evaluateTranslationWithModel, learnWorkingTermsWithModel } from "../src/provider.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";

const execute = promisify(execFile);
const pack = { source: "隊長のリン", targetLocale: "zh-CN", sourceLanguage: "Japanese", targetLanguage: "简体中文", neighborContext: { note: "A 对 B" } };

test("批内并发共享指南，版本和权限按阶段复核，资料复用保留原行和语境", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "kami-evidence-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const guide = join(workspace, "O'Brien 指南.docx"), ref = join(workspace, "names.txt");
  async function document(text, visual = false) {
    const archive = new JSZip();
    archive.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
    if (visual) archive.file("word/media/rule.png", "visual evidence");
    await writeFile(guide, await archive.generateAsync({ type: "nodebuffer" }));
  }
  await document("例外规则甲");
  await writeFile(ref, "说话人/对象/称呼\nA/B/リン\n另一个人物");
  let denied = false, fullReads = 0;
  const cache = { guides: new Map(), snippets: new Map() };
  const bash = process.platform === "win32" ? resolve((await execute("git", ["--exec-path"])).stdout.trim(), "../../../bin/bash.exe") : "bash";
  let scratch = await mkdtemp(join(workspace, "session-"));
  const runner = (shell = "bash") => batchReferenceEvidence({ cache, workspace, shell, scratchDirectory: async () => scratch, styleGuides: [{ path: "O'Brien 指南.docx" }], references: [{ path: "names.txt" }],
    dispatch: async (name, { command, workdir }) => {
      if (denied) return { isError: true };
      assert.doesNotMatch(command, /[\r\n]/, "the shell receives one short command, never the Python source");
      const token = command.split(" ").at(-1);
      if (JSON.parse(Buffer.from(token, "base64")).op === "guide") fullReads++;
      const { stdout } = name === "bash"
        ? await execute(bash, ["-c", command], { cwd: workdir })
        : await execute("pwsh", ["-NoProfile", "-Command", command], { cwd: workdir });
      return { value: { exitCode: 0, stdout: { text: stdout, truncated: false } } };
    } });
  const first = runner(), second = runner();
  const both = await Promise.all([first.prepare(pack), second.prepare(pack)]);
  assert.equal(fullReads, 1);
  assert.deepEqual(both[0].guides, both[1].guides);
  assert.match(both[0].guides[0].content, /例外规则甲/);
  assert.match(both[0].guides[0].content, /FF0000/);
  if (process.platform === "win32") assert.match((await runner("pwsh").prepare(pack)).guides[0].content, /例外规则甲/);
  await rm(scratch, { recursive: true });
  scratch = await mkdtemp(join(workspace, "session-"));
  const lookup = await first.lookup({ path: "names.txt", query: "リン" });
  assert.match(lookup.text, /说话人\/对象\/称呼/);
  assert.match((await second.prepare({ ...pack, source: "リン、来て。" })).snippets[0], /"line":2/);
  assert.equal((await runner().prepare({ ...pack, neighborContext: { note: "B 对 A" } })).snippets.length, 0);
  await document("新版本规则乙（已修正）");
  await writeFile(ref, "说话人/对象/新版称呼\nA/B/リン");
  const changed = await second.prepare(pack);
  assert.match(changed.guides[0].content, /新版本规则乙/);
  assert.equal(changed.snippets.length, 0);
  denied = true;
  const blocked = await second.prepare(pack);
  assert.deepEqual(blocked, { guides: [], snippets: [], allGuides: false });
  denied = false;
  await document("部分文本", true);
  assert.equal((await runner().prepare(pack)).allGuides, false);
});

test("初译和校对前缀一致，校对保留证据及对应的调用，剔除准备步骤与失败记录", async () => {
  const calls = [];
  const toolRunner = { prepareEvidence: async () => ({ guides: [{ path: "guide.md", content: "GUIDE_EXCEPTION" }], allGuides: true }),
    tools: ["skill", "read"].map(name => ({ type: "function", function: { name, parameters: {} } })), maxRounds: 2,
    execute: async ({ name }) => ({ text: name === "read" ? "角色事实" : "SETUP_NOISE" }) };
  const session = { toolRunner };
  await withRuntimeCall({ modelAdapter: async (messages, opts) => {
    calls.push({ messages, label: opts.requestLabel });
    if (calls.length === 1) return { toolCalls: ["skill", "read"].map(name => ({ id: name, function: { name, arguments: "{}" } })) };
    return { content: "林队长" };
  } }, async () => {
    await translateWithReflection(pack, { toolRunner, referenceSession: session, singlePass: true });
    await proofreadTranslationWithModel({ contextPack: pack, translation: "林队长", referenceSession: session });
  });
  const proof = calls.at(-1).messages;
  assert.deepEqual(calls[0].messages.slice(0, 2), proof.slice(0, 2));
  assert.match(JSON.stringify(proof), /GUIDE_EXCEPTION/);
  assert.match(JSON.stringify(proof), /角色事实/);
  assert.doesNotMatch(JSON.stringify(proof), /SETUP_NOISE|"id":"skill"/);
  assert.match(proof.at(-1).content, /林队长/);
});

test("工作术语学习先匹配后限量，保留表尾别名命中，组内句段不拼接命中", async () => {
  let payload;
  const known = Array.from({ length: 90 }, (_, i) => ({ source: "unrelated" + i }));
  await withRuntimeCall({ modelAdapter: async messages => {
    payload = JSON.parse(messages.at(-1).content);
    return { content: '{"terms":[]}' };
  } }, () => learnWorkingTermsWithModel({ entries: [{ id: "a", source: "隊長" }, { id: "b", source: "リン" }],
    existingTerms: [...known, { source: "隊長リン" }, { source: "main", aliases: ["unknown", "リン"] }],
    workingTerms: [...known, { source: "隊長", target: "队长" }] }));
  assert.deepEqual(payload.existingTerms, [{ source: "main", target: "", aliases: ["リン"] }]);
  assert.deepEqual(payload.workingTerms, [{ source: "隊長", target: "队长" }]);
});


test("独立模型 QA 在首次调用就获得已核实的完整指南，并在格式重试时保留它", async () => {
  let preparations = 0, calls = 0;
  const toolRunner = { tools: [{ type: "function", function: { name: "read", parameters: {} } }],
    execute: async () => { throw new Error("格式重试无需再次调用原件工具"); },
    prepareEvidence: async context => { assert.equal(context, pack); preparations++; return { guides: [{ path: "qa.docx", content: "QA_GUIDE_EXCEPTION" }] }; } };
  await withRuntimeCall({ modelAdapter: async messages => {
    calls++;
    assert.match(JSON.stringify(messages), /QA_GUIDE_EXCEPTION/);
    return { content: calls === 1 ? "invalid" : '{"issues":[]}' };
  } }, () => evaluateTranslationWithModel({ contextPack: pack, translation: "林队长", referenceSession: { contextPack: pack, toolRunner } }));
  assert.equal(calls, 2);
  assert.equal(preparations, 1);
});
