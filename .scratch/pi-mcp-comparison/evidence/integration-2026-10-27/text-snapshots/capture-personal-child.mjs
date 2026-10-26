import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [source,out]=process.argv.slice(2),from=name=>import(pathToFileURL(path.join(source,name)).href);
if(!fs.existsSync(path.join(out,'node_modules')))fs.symlinkSync(path.join(source,'node_modules'),path.join(out,'node_modules'),'dir');
const {BACKGROUND_CONTEXT}=await import('@earendil-works/chord/context');
const {openPersonalHarness}=await from('apps/ruukoto/src/personal-harness.ts');
const {personalProvider}=await from('apps/ruukoto/src/personal-model.ts');
const {parsePersonalMcp}=await from('apps/ruukoto/src/personal-mcp-config.ts');
const {PersonalMockModelServer}=await from('test/helpers/mock-provider.ts');
const {startMockMcp}=await from('test/helpers/mock-mcp.ts');
const {selectContext,DEFAULT_BUDGET_CONFIG}=await from('packages/agent/src/context-selector.ts');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rk-text-child-')));
const mcp=await startMockMcp({tools:[{name:'capture',description:'读取当前对象并返回原文',inputSchema:{type:'object',properties:{}},result:{content:[{type:'text',text:'子会话原服务结果'}]}}]});
let phase=0;
const model=new PersonalMockModelServer(request=>{
 if(!request.system?.includes('你是个人助手的子 Agent'))return {kind:'text',text:'拥有者来源已登记'};
 const names=(request.tools??[]).map(tool=>tool.function.name);for(const name of ['mcp_tools','mcp_call','read_mcp_result'])assert.ok(names.includes(name));
 if(phase++===0)return {kind:'tool_calls',calls:[{id:'definitions',name:'mcp_tools',arguments:{offset:0}}]};
 if(phase===2){assert.ok(JSON.stringify(request.messages).includes('读取当前对象并返回原文'));return {kind:'tool_calls',calls:[{id:'capture',name:'mcp_call',arguments:{service:'text',tool:'capture',arguments:{}}}]};}
 if(phase===3){const match=/"operation":(\d+)/.exec(String(request.messages.at(-1).content));assert.ok(match);return {kind:'tool_calls',calls:[{id:'original',name:'read_mcp_result',arguments:{operation:Number(match[1]),offset:0}}]};}
 assert.ok(JSON.stringify(request.messages).includes('子会话原服务结果'));return {kind:'text',text:'子会话读取完成'};
});
const config={api:'openai-completions',baseUrl:await model.start(),modelId:'mock-model',apiKeyEnv:'TEXT_AUDIT_CHILD_MODEL_KEY',contextWindow:128000,maxTokens:8192};
const mcpConfig=parsePersonalMcp({version:4,generation:'text-child-audit',services:[{id:'text',label:'文本证据服务',endpoint:mcp.url,enabled:true,tools:[{name:'capture',description:'读取当前对象并返回原文',inputSchema:{type:'object',properties:{}}}],toolEffects:{capture:'read'}}]});
process.env.TEXT_AUDIT_CHILD_MODEL_KEY='test-only';let p;
try{
 p=await openPersonalHarness({directory:path.join(root,'profile'),provider:personalProvider(config),modelId:config.modelId,mcp:mcpConfig});
 await p.answer('登记本次独立子工作来源','owner-source');
 const work=await p.work.delegate({requestId:'text-child',sourceRequestId:'owner-source',content:'先读取原工具定义，调用读取工具，再查询原操作结果'});
 await p.harness.waitForTask(work.taskId,BACKGROUND_CONTEXT);
 const task=await p.harness.commit(tx=>tx.task(work.taskId),BACKGROUND_CONTEXT);assert.equal(task.state.status,'terminal');
 const calls=model.calls.filter(request=>request.system?.includes('你是个人助手的子 Agent'));assert.equal(calls.length,4);
 const evidence=await p.harness.commit(async tx=>(await tx.scanEntries({conversationId:work.agentId,order:'ascending'},256)).items.filter(entry=>entry.kind==='ruukoto.model-request'),BACKGROUND_CONTEXT);
 assert.equal(evidence.filter(entry=>entry.data.payload).length,calls.length);
 for(const call of calls)assert.ok(evidence.some(entry=>JSON.stringify(entry.data.payload)===JSON.stringify(call.raw)),'实际provider请求可从持久记录重建');
 assert.equal(mcp.hits.filter(hit=>hit.rpcMethod==='tools/call').length,1);
 fs.writeFileSync(path.join(out,'after-personal-child-provider.json'),JSON.stringify(calls,null,2)+'\n');
 fs.writeFileSync(path.join(out,'after-personal-child-requests.json'),JSON.stringify(evidence,null,2)+'\n');
 const summaries=calls.map((call,index)=>{const tools=call.tools.map(tool=>({name:tool.function.name,description:tool.function.description,parameters:tool.function.parameters}));const selected=selectContext({messages:[],systemPrompt:call.system??'',tools,memories:[],budget:{...DEFAULT_BUDGET_CONFIG,contextWindow:128000,maxTokens:8192}});return {identity:'personal-child',callIndex:index+1,toolSchemas:selected.estimates.toolSchemas,systemPrompt:selected.estimates.systemPrompt,estimateMethod:'对实际provider输入使用共用context-selector静态估算，无Personal选择记录',tools:tools.map(tool=>tool.name)};});
 fs.writeFileSync(path.join(out,'after-personal-child-summary.json'),JSON.stringify(summaries,null,2)+'\n');console.log(JSON.stringify(summaries));
}finally{await p?.close();await model.close();await mcp.close();delete process.env.TEXT_AUDIT_CHILD_MODEL_KEY;fs.rmSync(root,{recursive:true,force:true});}
