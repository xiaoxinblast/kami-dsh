import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbench } from "../dsh/workbench.mjs";
import { workspaceFs } from "./helpers/workspace-fs.mjs";
import { getBatchRun, saveBatchRun } from "../src/store.mjs";

test("工作台一致性全查可复用成功分片，工作区已关联参考文件也不会触发读取", async () => {
  const root = await mkdtemp(join(tmpdir(),"kami-consistency-cache-")), cwd=join(root,"work"), dataDirectory=join(root,"data");
  await mkdir(cwd);
  const { fs, close }=await workspaceFs(), calls=[];
  const adapter=Object.assign(async(messages, options)=>{
    calls.push(options.requestLabel);
    assert.equal(options.tools?.length || 0, 0);
    assert.ok(!JSON.stringify(messages).includes("SUPPLEMENTARY_SECRET_FIXTURE"));
    return {content:'{"findings":[]}'};
  },{describe:async()=>({model:"fixture",provider:"fixture"})});
  const wb=await createWorkbench({dataDirectory,modelAdapter:adapter});
  const ctx={cwd,fs,human:true,referenceTools(){throw Error("补充资料工具不应装配");}};
  try {
    const {project}=await wb.workspace({action:"bind",name:"分片复查"},ctx);
    await writeFile(join(cwd,"ref.txt"),"SUPPLEMENTARY_SECRET_FIXTURE");
    await wb.importFile({purpose:"reference",path:"ref.txt",projectId:project.id},ctx);
    await writeFile(join(cwd,"source.mqxliff"),'<xliff version="1.2"><file><body><trans-unit id="1"><source>通知。</source><target/></trans-unit></body></file></xliff>');
    const {batchId}=await wb.importFile({path:"source.mqxliff",projectId:project.id},ctx);
    const loaded=await getBatchRun(batchId);
    await saveBatchRun({...loaded,runState:"completed",segments:loaded.segments.map(s=>({...s,status:"done",translation:"通知。"}))});
    const path="/api/batch/run/"+batchId+"/consistency-check";
    async function check() {
      const start=await wb.invoke({path,method:"POST",body:{projectId:project.id}},ctx);
      assert.equal(start.pending,true);
      for(let i=0;i<200;i++){
        const detail=await wb.invoke({path:path+"?projectId="+project.id},ctx);
        if(!detail.pending){assert.ok(detail.report);assert.equal(detail.warning,"");return;}
        await new Promise(r=>setTimeout(r,15));
      }
      assert.fail("检查超时");
    }
    await check();await check();assert.deepEqual(calls,["一致性检查"]);
    const saved=await getBatchRun(batchId);
    assert.ok(saved.qualityReport.chunkResults["check:0"].key);
    saved.segments[0].translation="提醒。";await saveBatchRun(saved);await check();
    assert.deepEqual(calls,["一致性检查","一致性检查"]);
  } finally {await wb.close();await close();await rm(root,{recursive:true,force:true});}
});
