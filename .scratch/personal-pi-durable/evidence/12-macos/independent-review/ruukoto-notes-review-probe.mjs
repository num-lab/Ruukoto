import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {BACKGROUND_CONTEXT as c} from '@earendil-works/chord/context';
import {ROOT_CONVERSATION_ID} from '@earendil-works/pi-durable';
import {openPersonalHarness} from './apps/ruukoto/src/personal-harness.ts';
import {personalProvider} from './apps/ruukoto/src/personal-model.ts';
import {PersonalWorkDoc,verifyPersonalWorkNotes} from './apps/ruukoto/src/personal-work.ts';
import {MockModelServer} from './test/helpers/mock-provider.ts';
const dir=fs.mkdtempSync('/tmp/rk-note-review-');
let release; const gate=new Promise(r=>release=r);
const server=new MockModelServer(async req=>{
 if(req.system?.includes('你是个人助手的子 Agent')) {await gate; return {kind:'text',text:'child'};}
 if(req.messages.at(-1)?.role==='tool') return {kind:'text',text:'listed'};
 if(req.messages.at(-1)?.content==='list') return {kind:'tool_calls',calls:[{id:'list-only',name:'background_work',arguments:{action:'list'}}]};
 return {kind:'text',text:'source'};
});
const config={api:'openai-completions',baseUrl:await server.start(),modelId:'mock-model',apiKeyEnv:'RUUKOTO_NOTE_REVIEW_KEY',contextWindow:128000,maxTokens:8192};
process.env[config.apiKeyEnv]='test';
let p;
try {
 p=await openPersonalHarness({directory:dir,provider:personalProvider(config),modelId:config.modelId});
 process.stdout.write('opened\n'); await p.answer('source','owner'); process.stdout.write('source done\n');
 const ref=await p.work.delegate({requestId:'review-work',sourceRequestId:'owner',content:'blocked'});
 process.stdout.write('delegate done\n'); await p.answer('list','list-owner'); process.stdout.write('list done\n');
 const tools=(await p.harness.commit(tx=>tx.scanTasks({kind:'pi.tool'},32),c)).items;
 const listTool=tools.find(t=>t.input?.callId==='list-only'); assert.ok(listTool);
 await p.work.append(ref,{requestId:'original-note',content:'fake append source',sourceRequestId:'owner'});
 const saved=await p.harness.snapshot(PersonalWorkDoc,ref.requestId,c); assert.equal(saved.notes.length,1);process.stdout.write('first note persisted exactly once: true\n');
 await p.harness.commit(async tx=>{
   const note=(await tx.doc(PersonalWorkDoc,ref.requestId,null)).notes[0];
   note.requestId=`personal-note-tool:${listTool.id}`;
   note.source.modelCall=listTool.id;
 },c);
 let accepted=false;
 try {await p.harness.commit(tx=>verifyPersonalWorkNotes(tx,ref,true),c); accepted=true;} catch(e) {process.stdout.write(`rejected: ${e.code} ${e.message}\n`);}
 process.stdout.write(`unrelated list tool accepted as append source: ${accepted}\n`);
 await p.harness.commit(async tx=>{delete (await tx.doc(PersonalWorkDoc,ref.requestId,null)).notes[0].source.modelCall;},c);
 let downgraded=false;try{await p.harness.commit(tx=>verifyPersonalWorkNotes(tx,ref,true),c);downgraded=true;}catch(e){process.stdout.write(`missing call rejected: ${e.code}\n`);}
 process.stdout.write(`reserved model note accepted without modelCall: ${downgraded}\n`);
} finally {release(); await p?.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});}
