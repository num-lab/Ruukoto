import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {openPersonalHarness} from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-harness.ts';
import {personalProvider} from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-model.ts';
import {MockModelServer} from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/helpers/mock-provider.ts';
const expected=JSON.parse(fs.readFileSync('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/.scratch/personal-pi-durable/evidence/10-macos/model-input.json','utf8'));
const server=new MockModelServer(request=>request.system?.includes('你是个人助手的子 Agent')?{kind:'text',text:'完成'}:request.messages.at(-1)?.role==='tool'?{kind:'text',text:'已登记'}:{kind:'tool_calls',calls:[{id:'delegate',name:'background_work',arguments:{action:'delegate',content:'分析'}}]});
const config={api:'openai-completions',baseUrl:await server.start(),modelId:'mock-model',apiKeyEnv:'RK_REVIEW_TEST_KEY',contextWindow:128000,maxTokens:1024};process.env.RK_REVIEW_TEST_KEY='test-only';
const directory='/tmp/ruukoto-model-review-tJYsF1/input-profile';
const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId});
try {
 await p.answer('委派','owner');
 const ctx=(await import('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/node_modules/@earendil-works/chord/dist/context/index.js')).BACKGROUND_CONTEXT; const tasks=await p.harness.commit(tx=>tx.scanTasks({kind:'ruukoto.background-work'},1),ctx); await p.harness.waitForTask(tasks.items[0].id,ctx);
 const main=server.calls.find(r=>r.tools?.some(t=>t.function?.name==='background_work'));
 const child=server.calls.find(r=>r.system?.includes('你是个人助手的子 Agent'));
 const tool=server.calls.flatMap(r=>r.messages).find(m=>m.role==='tool');
 assert.equal(main.system,expected.main.system);assert.deepEqual(main.tools,expected.main.tools);
 assert.equal(child.system,expected.child.system);assert.deepEqual(child.tools??[],expected.child.tools);
 assert.deepEqual(tool,expected.main.toolResults[0]);
 const token=s=>Math.ceil(Buffer.byteLength(s,'utf8')/4);
 assert.equal(token(main.system),expected.estimates.after.systemPrompt);
 assert.equal(token(JSON.stringify(main.tools)),expected.estimates.after.toolSchemas);
 assert.equal(token(child.system),expected.estimates.child.systemPrompt);
 process.stdout.write(JSON.stringify({inputSnapshotMatchesActual:true,toolResultMatchesActual:true,after:{systemPrompt:token(main.system),toolSchemas:token(JSON.stringify(main.tools))},child:{systemPrompt:token(child.system),toolSchemas:0}})+'\n');
}finally{await p.close();await server.close();fs.rmSync(directory,{recursive:true,force:true});}
