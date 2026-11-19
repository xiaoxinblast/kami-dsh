import test from "node:test";
import assert from "node:assert/strict";
import { consistencyResultCache } from "../src/consistency-result-cache.mjs";
import { runFollowupGroups } from "../src/followup-batch.mjs";
import { listSurveyMemoryRows } from "../src/directus-store.mjs";
import { workspaceStyleGuide } from "../src/workspace-resources.mjs";
import { buildReferenceToolRunner } from "../src/reference-context.mjs";
import { withRuntimeCall } from "../src/runtime-context.mjs";
import { checkBatchConsistencyWithModel, evaluateTranslationWithModel, reviseTranslationWithQa } from "../src/provider.mjs";
import { indexSurveyMemories } from "../src/survey-memory-index.mjs";

const segments = ["a","b","c","d"].map(id => ({ id, source: "通知 " + id + "{0}", translation: "提示 " + id + "{0}", context: {scene:"物品栏"} }));
const run = { batchId: "b", projectId: "p", contentType: "ui", segments };
const guide = "完整指南与例外".repeat(160);
const sample = s => ({ source:s.source, targetLocale:"zh-CN", contentType:"ui", userProfile:{instruction:guide} });

test("改后批量 QA 保留完整指南，各段保留原上下文；重复与漏回 ID 只回退对应两段", async () => {
  const calls = [], groups = [];
  await withRuntimeCall({ modelAdapter: async (messages,opt) => {
    calls.push(opt.requestLabel);
    const content = messages.at(-1).content;
    assert.ok(content.includes(guide));
    if(opt.requestLabel === "小批改后 QA") {
      const rows = JSON.parse(content.slice(content.lastIndexOf("\n[{")+1)); groups.push(rows.map(r=>r.id));
      for (const row of rows) assert.ok(row.input.includes("提示 " + row.id));
      return { content: JSON.stringify({results:[{id:"a",issues:[]},{id:"b",issues:[]},{id:"b",issues:[]},{id:"d",issues:[]}]}) };
    }
    return {content:'{"issues":[]}'};
  }},async () => {
    const checked=await runFollowupGroups(run, segments.map(segment=>({segment})), "AIQA", ({segment:s})=>evaluateTranslationWithModel({contextPack:sample(s),translation:s.translation}));
    assert.equal(checked.size,4);
    assert.ok([...checked.values()].every(entry=>entry.value?.length===0));
  });
  assert.deepEqual(groups,[["a","b","c","d"]]);
  assert.deepEqual(calls,["小批改后 QA","AIQA","AIQA"]);
});

test("局部修订漏标记只回退该段；长段、不同场景和不明说话人分开处理", async () => {
  const labels=[];
  const adapter=async (messages,opts)=>{
    labels.push(opts.requestLabel);
    if(opts.requestLabel==="小批定向修订")return {content:JSON.stringify({results:segments.map(s=>({id:s.id,translation:s.id==="b"?"通知":"通知 "+s.id+"{0}"}))})};
    return {content:"通知 b{0}"};
  };
  await withRuntimeCall({modelAdapter:adapter}, async()=>{
    const worker=({segment:s})=>reviseTranslationWithQa({contextPack:sample(s),translation:s.translation,issues:[{message:"采用通知"}]});
    const checked=await runFollowupGroups(run,segments.map(segment=>({segment,targets:["通知"]})),"AIQA 修订",worker);
    assert.equal(checked.get("b").value,"通知 b{0}");assert.deepEqual(labels,["小批定向修订","AIQA 修订"]);
    labels.length=0;
    const s=[{...segments[0],source:"甲".repeat(451)}, {...segments[1],context:{scene:"乙"}}, {...segments[2],result:{segmentPurpose:"dialogue"}}, segments[3]];
    await runFollowupGroups({...run,segments:s},s.map(segment=>({segment})),"AIQA 修订",worker);
    assert.deepEqual(labels,Array(4).fill("AIQA 修订"));
  });
});

test("任何段准备失败都不会卡住合批，余额或网络错误也不会引起四次独立重发", async()=>{
  const calls=[];
  await withRuntimeCall({modelAdapter:async(_m,o)=>{calls.push(o.requestLabel);throw Error("insufficient balance")}},async()=>{
    const got=await runFollowupGroups(run,segments.map(segment=>({segment})),"AIQA",({segment:s})=>{
      if(s.id==="a")throw Error("无法读取输入");
      return evaluateTranslationWithModel({contextPack:sample(s),translation:s.translation});
    });
    assert.equal(got.size,4); assert.match(got.get("b").error.message,/insufficient balance/);
    assert.deepEqual(calls,["小批改后 QA"]);
  });
});

test("一致性缓存跨次复用，文本、邻段、证据、完整指南或模型变更都会失效；失败不会缓存",async()=>{
  let calls=0, route="test", currentGuide=guide, inducedFailure=false, facts=[], saved={};
  const adapter=Object.assign(async()=>{calls++;if(inducedFailure)throw Error("timeout");return {content:'{"findings":[]}' }},{describe:async()=>({model:route})});
  const pairs=[segments[0]];
  const check=async()=> {
    const chunkResults=consistencyResultCache({...run,qualityReport:{chunkResults:saved}},["test"]);
    const runner={guideOnly:true,tools:[],prepareEvidence:async()=>({guides:[{path:"guide.md",content:currentGuide}]})};
    const output=await withRuntimeCall({embedded:true,modelAdapter:adapter,modelRoute:{model:route},chunkResults},()=>checkBatchConsistencyWithModel({pairs,cacheSlot:"check:0",evidence:{terms:facts},toolRunner:runner}));
    saved=structuredClone(chunkResults.records);return output;
  };
  await check();await check();assert.equal(calls,1);
  segments[1].context.speaker="另一个人";
  try {
    await check();assert.equal(calls,2);currentGuide+="全文末尾的新例外";await check();assert.equal(calls,3);
    facts=[{source:"通知",target:"提示"}];await check();assert.equal(calls,4);
    route="another";await check();assert.equal(calls,5);
    const before=pairs[0].translation;
    try {pairs[0].translation+="已修改";inducedFailure=true;await assert.rejects(check(),/timeout/);inducedFailure=false;await check();await check();assert.equal(calls,7);}
    finally{pairs[0].translation=before;}
  } finally{delete segments[1].context.speaker;}
});

test("收尾不检索资料库、外部文件或网页，只加载风格指南，与翻译阶段的工具隔离",async()=>{
  let requested=0;
  const native=options=>{requested++;assert.deepEqual(options.references,[]);assert.equal(options.allowWeb,false);
    return {tools:[{function:{name:"grep"}}],prepareEvidence:async()=>({allGuides:true,guides:[{path:"a.txt",content:guide}],snippets:["其他参考资料"]}),dispose:async()=>{}}};
  const snapshot={projectId:"p",workspace:"test",styleGuideMode:"agent-native",referenceMode:"agent-native",resources:[{path:"reference.xlsx",purpose:"reference"},{path:"a.txt",purpose:"style-guide"}]};
  await withRuntimeCall({embedded:true,workspaceSnapshot:snapshot,referenceTools:native,followupOnly:true,modelAdapter:async(messages,opts)=>{
    assert.equal(opts.tools,undefined);const text=JSON.stringify(messages);assert.ok(text.includes(guide));assert.ok(!text.includes("其他参考资料"));return {content:'{"issues":[]}'};
  }},async()=>{
    assert.equal(workspaceStyleGuide("p"), undefined, "原件已由宿主加载，提示中不再要求模型调用工具");
    const runner=buildReferenceToolRunner({projectId:"p",allowWeb:true});
    await evaluateTranslationWithModel({contextPack:sample(segments[0]),translation:"提示",referenceSession:{contextPack:sample(segments[0]),toolRunner:runner}});
    const none=await withRuntimeCall({workspaceSnapshot:{...snapshot,styleGuideMode:"compiled"}},()=>buildReferenceToolRunner({projectId:"p",allowWeb:true}));
    assert.equal(none,null);assert.equal(requested,1);
  });
});

test("数据库限制单页行数时仍查全启用的 TM，只索取对齐所需字段", async () => {
  const offsets = [];
  const store = { async request(path) {
    const query = new URL(path, "http://localhost").searchParams;
    assert.equal(query.get("filter[project_id][_eq]"), "p");
    assert.equal(query.get("filter[library_id][_in]"), "m,r");
    assert.equal(query.get("fields"), "id,source,target,source_file,library_id");
    const offset = Number(query.get("offset"));
    offsets.push(offset);
    return offset < 2 ? [{id: String(offset), library_id: "m", source: "原词", target: "译词"}] : [];
  } };
  const rows = await withRuntimeCall({store}, () => listSurveyMemoryRows("zh-CN", "p", ["m","r"]));
  assert.deepEqual(offsets, [0, 1, 2]);
  assert.deepEqual(rows.map(row => row.id), ["0","1"]);
});

test("标记词索引保留重叠词、全半角、大小写、次序和所有来源，排除向量与停用库",()=>{
  const rows=[{id:"m",libraryId:"m",source:"星晶ＡＢ",target:"译文",embedding:[1,2]},{id:"r",linkedLibraryId:"r",source:"星晶aB",target:"另一译法"},{id:"w",libraryId:"w",source:"星晶",target:"其他"}];
  const ix=indexSurveyMemories(["晶","星晶","ab","ＡＢ","空"],[{id:"m",role:"master"},{id:"r",role:"reference"},{id:"w",role:"working"}],rows);
  for(const key of ["晶","星晶","ab","ＡＢ"])assert.deepEqual(ix.get(key).map(r=>r.id),["m","r"]);
  assert.equal(ix.get("空").length,0);assert.equal("embedding" in ix.get("ab")[0],false);
});
