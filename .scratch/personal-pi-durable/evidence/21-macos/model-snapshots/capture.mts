import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
const context = BACKGROUND_CONTEXT;
const base = process.env.RUUKOTO_REVIEW_SOURCE!;
const out = process.env.RUUKOTO_REVIEW_OUT!;
const {openPersonalHarness} = await import(pathToFileURL(path.join(base,"apps/ruukoto/src/personal-harness.ts")).href);
const {personalProvider} = await import(pathToFileURL(path.join(base,"apps/ruukoto/src/personal-model.ts")).href);
const {MockModelServer} = await import(pathToFileURL(path.join(base,"test/helpers/mock-provider.ts")).href);
const server = new MockModelServer(() => ({kind:"text",text:"本轮分析完成"}));
const root = fs.mkdtempSync(path.join(tmpdir(),"rk-request-capture-"));
let p;
try {
 const helper = path.join(root,"helper"); fs.mkdirSync(helper); const helperPath=path.join(helper,"helper.mjs");
 fs.copyFileSync(path.join(base,"test/helpers/fake-service-helper.mjs"),helperPath);
 const policyPath=path.join(helper,"policy.json"); fs.writeFileSync(policyPath,JSON.stringify({machineId:"test-machine",inspectUid:1,inspectGid:1,services:{"personal-test.service":{actions:["restart"]}}}));
 process.env.RUUKOTO_REVIEW_MODEL_KEY="test-only";
 const config={api:"openai-completions",baseUrl:await server.start(),modelId:"mock-model",apiKeyEnv:"RUUKOTO_REVIEW_MODEL_KEY",contextWindow:128000,maxTokens:1024};
 p=await openPersonalHarness({directory:path.join(root,"profile"),provider:personalProvider(config),modelId:config.modelId,service:{helperPath,policyPath,useSudo:false,sudoPath:"/usr/bin/sudo"},serviceOperations:true});
 await p.answer("请分析这项服务工作。","snapshot-owner");
 const work=await p.work.delegate({content:"只分析既有事实并返回结果。",requestId:"snapshot-child",sourceRequestId:"snapshot-owner"});
 await p.harness.waitForTask(work.taskId,context);
 assert.equal(server.calls.length,2);
 fs.mkdirSync(out,{recursive:true});
 for(const [index,role] of ["main","subagent"].entries()) {
  const call=server.calls[index]; const snapshot={systemPrompt:call.system,toolSchemas:call.tools,messages:call.messages,request:call.raw};
  fs.writeFileSync(path.join(out,role+".json"),JSON.stringify(snapshot,null,2)+"\n");
 }
 const estimate=server.calls.map((call,index)=>({role:index?"subagent":"main",systemPromptCharacters:(call.system??"").length,toolSchemasCharacters:JSON.stringify(call.tools??[]).length,systemPrompt:Math.ceil((call.system??"").length/4),toolSchemas:Math.ceil(JSON.stringify(call.tools??[]).length/4)}));
 fs.writeFileSync(path.join(out,"estimates.json"),JSON.stringify({method:"UTF-16 字符数除以 4 向上取整；只作统一近似，不是模型 tokenizer 计数。",estimates:estimate},null,2)+"\n");
 process.stdout.write(JSON.stringify(estimate)+"\n");
} finally { await p?.close(); await server.close(); fs.rmSync(root,{recursive:true,force:true}); }
