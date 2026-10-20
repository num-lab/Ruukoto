import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openPersonalHarness } from './apps/ruukoto/src/personal-harness.ts';
import { personalProvider } from './apps/ruukoto/src/personal-model.ts';
import { MockModelServer } from './test/helpers/mock-provider.ts';
import { toolOperations,PersonalToolDoc } from './apps/ruukoto/src/personal-tools.ts';
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rk29-harness-review-'))),workspace=path.join(root,'work');fs.mkdirSync(workspace);
const stat=fs.statSync(workspace),tools={version:1,generation:'review-first',workspace,identity:{dev:stat.dev,ino:stat.ino},credentials:[]};
const model=new MockModelServer(req=>{const last=req.messages.at(-1); if(last?.role==='user' && String(last.content).startsWith('tool:')){const call=JSON.parse(String(last.content).slice(5));return {kind:'tool_calls',calls:[{id:'one',name:call.name,arguments:call.args}]};} return {kind:'text',text:last?.role==='tool'?String(last.content):'done'};});
const config={api:'openai-completions',baseUrl:await model.start(),modelId:'mock-model',apiKeyEnv:'RK29_REVIEW_MODEL',contextWindow:128000,maxTokens:8192};process.env[config.apiKeyEnv]='dummy';
const options={directory:path.join(root,'profile'),provider:personalProvider(config),modelId:config.modelId,tools};let p;
try {
 p=await openPersonalHarness(options);
 fs.writeFileSync(path.join(workspace,'new'),'original');
 const write=JSON.parse(await p.answer('tool:'+JSON.stringify({name:'write_file',args:{path:path.join(workspace,'new'),content:'expected-new-content'}}),'write'));
 const read=JSON.parse(await p.answer('tool:'+JSON.stringify({name:'read_file',args:{path:path.join(workspace,'new')}}),'read'));
 console.log(JSON.stringify({writeCode:write.code,writeEffect:write.effect,readCode:read.code,readPreview:read.preview}));
 const page=await p.answer('tool:'+JSON.stringify({name:'read_artifact',args:{artifact:read.artifact}}),'artifact-read');console.log(JSON.stringify({artifactRead:page}));
 try{await p.tools.export(read.artifact,path.join(root,'exported'));console.log('exported');}catch(error){console.log(JSON.stringify({exportError:error.code,message:error.message}));}
 await p.close();p=await openPersonalHarness(options);
 const ops=await p.harness.commit(async tx=>JSON.parse(JSON.stringify(await toolOperations(tx))),BACKGROUND_CONTEXT);console.log(JSON.stringify({reopened:true,operations:ops.length,artifacts:ops.filter(x=>x.artifact).length}));
} finally {await p?.close();await model.close();fs.rmSync(root,{recursive:true,force:true});delete process.env[config.apiKeyEnv];}
