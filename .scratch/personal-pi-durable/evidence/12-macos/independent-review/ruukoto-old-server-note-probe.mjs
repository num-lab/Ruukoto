import assert from 'node:assert/strict';
import fs from 'node:fs';
import {BACKGROUND_CONTEXT as c} from '@earendil-works/chord/context';
import {openPersonalHarness} from './apps/ruukoto/src/personal-harness.ts';
import {personalProvider} from './apps/ruukoto/src/personal-model.ts';
import {savePersonalConfig} from './apps/ruukoto/src/personal-config.ts';
import {preparePersonalInput,checkPersonalInput,pendingPersonalInputs} from './apps/ruukoto/src/personal-cli.ts';
import {personalControl} from './apps/ruukoto/src/personal-control.ts';
import {startPersonalServer} from '/tmp/ruukoto-notes-independent-xe6ipwur/old-control.mts';
import {MockModelServer} from './test/helpers/mock-provider.ts';
const dir=fs.mkdtempSync('/tmp/rk-old-daemon-note-');
const model=new MockModelServer(()=>({kind:'text',text:'answer'}));
const cfg={api:'openai-completions',baseUrl:await model.start(),modelId:'mock-model',apiKeyEnv:'RUUKOTO_OLD_DAEMON_NOTE_KEY',contextWindow:128000,maxTokens:8192};
process.env[cfg.apiKeyEnv]='test'; savePersonalConfig(dir,cfg);
let p,server;
try {
 p=await openPersonalHarness({directory:dir,provider:personalProvider(cfg),modelId:cfg.modelId});
 await p.answer('owner','owner');
 const ref=await p.work.delegate({requestId:'work',content:'initial',sourceRequestId:'owner'});
 await p.harness.waitForTask(ref.taskId,c); await p.close();p=undefined;
 server=await startPersonalServer(dir);
 const input=preparePersonalInput(dir,'THIS SHOULD BE A WORK NOTE',ref.taskId);
 let status;try {await personalControl(dir,'POST',input.work===undefined?'/inputs':'/work/notes',input);}catch(e){status=e.code;}
 let query;try {query=await checkPersonalInput(dir,input);}catch(e){query=e.code;}
 const messages=await personalControl(dir,'GET','/messages');
 process.stdout.write(JSON.stringify({status,query,pending:pendingPersonalInputs(dir).length,messages},null,2)+'\n');
} finally {await server?.stop();await p?.close();await model.close();fs.rmSync(dir,{recursive:true,force:true});}
