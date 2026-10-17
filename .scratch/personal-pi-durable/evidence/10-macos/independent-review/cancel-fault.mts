import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {openPersonalHarness} from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-harness.ts';
import {personalProvider} from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-model.ts';
import {PersonalAgentsDoc,PersonalWorkDoc} from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-work.ts';
import {MockModelServer} from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/helpers/mock-provider.ts';
import {BACKGROUND_CONTEXT as context} from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/node_modules/@earendil-works/chord/dist/context/index.js';
let release; const gate=new Promise(resolve=>{release=resolve});
let ref;
const server=new MockModelServer(async request=>{
  if(request.system?.includes('你是个人助手的子 Agent')) {await gate; return {kind:'text',text:'late'};}
  if(request.messages.at(-1)?.role==='tool') return {kind:'text',text:String(request.messages.at(-1)?.content)};
  return {kind:'tool_calls',calls:[{id:'test',name:'background_work',arguments: request.messages.at(-1)?.content==='cancel' ? {action:'cancel',work:ref.taskId} : {action:'delegate',content:'waiting'}}]};
});
const config={api:'openai-completions',baseUrl:await server.start(),modelId:'mock-model',apiKeyEnv:'RK_REVIEW_TEST_KEY',contextWindow:128000,maxTokens:1024};
process.env.RK_REVIEW_TEST_KEY='test-only';
const directory='/tmp/ruukoto-model-review-tJYsF1/profile';
const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId});
try {
 await p.answer('delegate','first');
 const agents=await p.work.list(); ref=agents[0].work;
 for(let i=0;server.calls.length<3&&i<1000;i++) await delay(2);
 await p.harness.commit(async tx=>{const doc=await tx.doc(PersonalAgentsDoc);doc.agents[0].work.taskId=999999;},context);
 const response=await p.answer('cancel','cancel');
 const status=await p.work.status(ref);
 const child=await p.harness.conversation(ref.agentId,context);
 process.stdout.write(JSON.stringify({response,outcome:status.task.state,childLive:await p.harness.snapshot((await import('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/node_modules/@earendil-works/pi-durable/dist/index.js')).LiveDoc,ref.agentId,context),agent:(await p.work.list())[0]})+'\n');
 assert.match(response,/stop_unverified/);
 assert.equal(status.task.state.outcome.status,'faulted');
} finally {release(); await p.close(); await server.close();fs.rmSync(directory,{recursive:true,force:true});}
