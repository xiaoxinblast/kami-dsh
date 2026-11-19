import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextPack } from "../src/context-pack.mjs";
import { selectPatternReferences } from "../src/pattern-memory.mjs";
import { packPrompt, translateMicroBatchWithModel } from "../src/provider.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { createWorkbench } from "../dsh/workbench.mjs";
import { listTranslationSkills, saveMemory, saveResourceLibrary, saveTranslationSkill } from "../src/store.mjs";

const br = "<tag id='tag-1' type='inline' desc='ph'/>";
const br2 = "<tag id='tag-2' type='inline' desc='ph'/>";
const sources = [
  `門を閉ざす…国を守る隊長の${br}決断に対し、村を捨てることを${br2}受け入れられない弓兵は、反乱を起こす`,
  `友軍と合流し、北の峠へ${br}進軍する隊長。谷の住人を${br2}守るため、追手との最終決戦に挑む`,
  `古城を制圧する…家族を守る隊長の${br}決断に対し、仲間を救いたい衛兵は${br2}反乱を起こす`,
  `偵察隊と協力し、東の港へ進軍する${br}隊長。故郷の未来のため、${br2}海賊との最終決戦に挑む`,
  `山に砦を築く…険しい道を選ぶ隊長の${br}決断に対し、師匠の教えを${br2}貫くべく、斥候は反乱を起こす`,
  `同盟軍の要請を受け、南の島へ${br}進軍する隊長。争いに終止符を${br2}打つため、守備隊との最終決戦に挑む`
];
const targets = [
  `关闭城门……面对队长为保卫国家作出的${br}决定，弓手无法接受弃村的命令，${br2}发动了叛乱。`,
  `队长与友军会合，向北方山口${br}进军。为了保护山谷居民，${br2}他与追兵展开最终决战。`,
  `攻占古堡……面对队长为保护家人作出的${br}决定，卫兵为了救出同伴，${br2}发动了叛乱。`,
  `队长与侦察队协作，向东港${br}进军。为了家乡的未来，${br2}他与海盗展开最终决战。`,
  `在山中筑堡……面对队长选择险路的${br}决定，斥候为了贯彻师父的教诲，${br2}发动了叛乱。`,
  `队长应盟军请求，向南方岛屿${br}进军。为了平息纷争，${br2}他与守军展开最终决战。`
];
const rows = sources.map((source, i) => ({ segmentId: String(77 + i), source, target: targets[i], accepted: i === 0 }));
const pack = (source, options) => buildContextPack({ source, locale: "zh-CN", classification: { contentType: "narrative" }, matches: [], ...options });

test("面板和晋升策略的译例条数贯穿工作台检索及初译和校对请求", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kami-tm-limit-"));
  const source = "図書館の古い扉を開ける。", calls = [];
  const wb = await createWorkbench({ dataDirectory: directory, modelAdapter: async (messages, options) => {
    const text = messages.map(message => message.content).join("\n");
    calls.push([options.requestLabel, new Set(text.match(/TM_SAMPLE_\d+/gu)).size]);
    return { content: "打开图书馆的老门。" };
  } });
  const post = (path, body) => wb.invoke({ path, method: "POST", body }, { human: true });
  try {
    const { project } = await post("/api/projects", { name: "译例上限回归" });
    const projectId = project.id;
    const library = await saveResourceLibrary({ projectId, kind: "translation_memory", role: "reference", name: "参考译例", enabled: true });
    for (let i = 0; i < 20; i++) await saveMemory("zh-CN", { projectId, project: i % 2 ? projectId : "default", libraryId: library.id, source,
      target: "参考译例 TM_SAMPLE_" + i, qualityStatus: "human_approved", contentType: "narrative", domain: "game" });
    const body = { projectId, source, domain: "game", locale: "zh-CN", contentType: "narrative", useModelClassification: false };
    for (const panel of [2, 5, 10, 20]) {
      await post("/api/settings", { retrieval: { translationMemoryLimit: panel } });
      const response = await post("/api/translate", body);
      assert.equal(response.contextPack.translationReferences.length, panel);
      assert.deepEqual(calls.splice(0), [["翻译", panel], ["模型校对", panel]]);
    }
    const [skill] = await listTranslationSkills({ project: projectId, status: "champion", limit: 1 });
    skill.strategy.retrieval.translationMemory.limit = 10;
    await saveTranslationSkill(skill);
    await post("/api/translate", body);
    assert.deepEqual(calls.splice(0), [["翻译", 10], ["模型校对", 10]]);
  } finally {
    await wb.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("同文件只为同一组固定分句取例，保留变量和译例的采纳状态", () => {
  for (let i = 2; i < rows.length; i++) {
    const refs = selectPatternReferences({ source: sources[i], previous: rows.slice(0, i) });
    const expected = rows.slice(0, i).filter((_, j) => j % 2 === i % 2);
    assert.deepEqual(refs.map(row => row.segmentId).sort(), expected.map(row => row.segmentId));
    for (const ref of refs) {
      const original = rows.find(row => row.segmentId === ref.segmentId);
      assert.equal(ref.accepted, original.accepted);
      assert.equal(ref.target, original.target);
      assert.equal(ref.source, original.source);
      assert.ok(ref.fixedPhrases.some(text => text.includes(i % 2 ? "最終決戦に挑む" : "反乱を起こす")));
    }
    const prompt = packPrompt(pack(sources[i], { patternReferences: refs }));
    assert.match(prompt, /固定表达/u);
    assert.ok(prompt.includes(sources[i]));
  }
  for (const source of ["隊長の旅立ち。星を見る", "全員を解放する。異国の兵士が反乱を起こす", "革命軍は反乱を起こす。将軍の決断に対し、町を守る"]) {
    assert.deepEqual(selectPatternReferences({ source, previous: rows }), []);
  }
  assert.deepEqual(selectPatternReferences({ source: "隊長", terms: [{ source: "衛兵" }, { source: "隊長" }],
    previous: [{ source: "衛兵", target: "卫兵" }] }), []);
});

test("小批初译和校对在没有任何先前译稿时都收到同句式条目关系", async () => {
  const entries = rows.map(row => ({ id: row.segmentId, contextPack: pack(row.source), translation: row.target }));
  for (const part of ["translate", "proofread"]) {
    let calls = 0;
    const result = await withRuntimeCall({ modelAdapter: async messages => {
      calls++;
      const prompt = messages.at(-1).content;
      const line = prompt.split("\n").find(s => s.startsWith("组内同句式 "));
      assert.ok(line);
      const links = JSON.parse(line.slice("组内同句式 ".length));
      assert.deepEqual(links.map(({ ids }) => ids[1]), ["79", "80", "81", "82"]);
      for (const { ids, fixedPhrases } of links) {
        assert.equal(Number(ids[0]) % 2, Number(ids[1]) % 2);
        assert.ok(fixedPhrases.some(s => s.includes(Number(ids[0]) % 2 ? "反乱を起こす" : "最終決戦に挑む")));
      }
      for (const source of sources) assert.ok(prompt.includes(source));
      return { content: JSON.stringify({ translations: [...entries].reverse().map(e => ({ id: e.id, translation: e.translation })) }) };
    }, modelRoute: { provider: "test", model: "test" } }, () => translateMicroBatchWithModel(entries, { part }));
    assert.equal(calls, 1);
    assert.deepEqual(result.map(row => row.translation), targets);
  }
});
