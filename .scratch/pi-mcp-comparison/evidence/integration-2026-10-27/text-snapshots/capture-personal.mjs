import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const [source,out,stage]=process.argv.slice(2),from=name=>import(pathToFileURL(path.join(source,name)).href);
const {openPersonalHarness}=await from('apps/ruukoto/src/personal-harness.ts');
const {personalProvider}=await from('apps/ruukoto/src/personal-model.ts');
const {parsePersonalMcp}=await from('apps/ruukoto/src/personal-mcp-config.ts');
const {PersonalMockModelServer}=await from('test/helpers/mock-provider.ts');
const {selectContext,DEFAULT_BUDGET_CONFIG}=await from('packages/agent/src/context-selector.ts');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rk-text-personal-')));
const model=new PersonalMockModelServer((_request,index)=>index===0?{kind:'tool_calls',calls:[{id:'definitions',name:'mcp_tools',arguments:{}}]}:{kind:'text',text:'完成'});
const config={api:'openai-completions',baseUrl:await model.start(),modelId:'mock-model',apiKeyEnv:'TEXT_AUDIT_MODEL_KEY',contextWindow:128000,maxTokens:8192};
const mcp=parsePersonalMcp({version:stage==='before'?2:4,generation:'text-audit',services:[{id:'test',label:'测试服务',endpoint:'http://127.0.0.1:1/mcp',enabled:true,tools:[{name:'capture',description:'只读查询',inputSchema:{type:'object',properties:{}}}],...(stage==='after'?{toolEffects:{capture:'unknown'}}:{})}]});
process.env.TEXT_AUDIT_MODEL_KEY='test-only';
let p;
try {
 p=await openPersonalHarness({directory:path.join(root,'profile'),provider:personalProvider(config),modelId:config.modelId,mcp});
 await p.answer('读取工具定义','text-audit');
 assert.equal(model.calls.length,2);
 fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,`${stage}-personal-provider.json`),JSON.stringify(model.calls,null,2)+'\n');
 const summaries=model.calls.map((call,index)=>{
  const tools=call.tools.map(tool=>({name:tool.function.name,description:tool.function.description,parameters:tool.function.parameters}));
  const systemPrompt=call.system??'';
  const selected=selectContext({messages:[],systemPrompt,tools,memories:[],budget:{...DEFAULT_BUDGET_CONFIG,contextWindow:128000,maxTokens:8192}});
  return {stage,identity:'personal-main',callIndex:index+1,toolSchemas:selected.estimates.toolSchemas,systemPrompt:selected.estimates.systemPrompt,toolCount:tools.length,estimateMethod:'共用context-selector默认预算估算，仅静态systemPrompt及toolSchemas，无Personal选择记录',mcpTools:tools.filter(tool=>['mcp_tools','mcp_call','read_mcp_result'].includes(tool.name))};
 });
 fs.writeFileSync(path.join(out,`${stage}-personal-summary.json`),JSON.stringify(summaries,null,2)+'\n');
 console.log(JSON.stringify(summaries.map(({mcpTools,...rest})=>rest)));
} finally {await p?.close();await model.close();delete process.env.TEXT_AUDIT_MODEL_KEY;fs.rmSync(root,{recursive:true,force:true});}
