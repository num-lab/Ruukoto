import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [source,out]=process.argv.slice(2),from=name=>import(pathToFileURL(path.join(source,name)).href);
const {startTestRuntime,realTools,waitFor,afterTool,toolNamesOf}=await from('test/helpers/testkit.ts');
const {startMockMcp}=await from('test/helpers/mock-mcp.ts');
const {product}=await from('apps/ruukoto-code/src/product.ts');
const {requireWorkflowRun,listWorkflowExecutions}=await from('packages/core/src/workflow.ts');
const mcp=await startMockMcp({tools:[{name:'capture',description:'读取当前对象并返回原文',inputSchema:{type:'object',properties:{}},result:{content:[{type:'text',text:'身份文本证据：读取成功'}]}}]});
let identity='code-subagent',phase=0;
const t=await startTestRuntime('text-identities',req=>{
 const names=toolNamesOf(req);
 if(phase++===0) {
  assert.ok(names.includes('mcp__text__capture'),'当前身份的固定工具清单从首轮直开');
  assert.ok(!names.includes('tool_search'),'固定清单不要求先搜索');
  return {kind:'tool_calls',calls:[{id:'capture',name:'mcp__text__capture',arguments:{}}]};
 }
 return {kind:'text',text:'身份读取完成'};
},{config:{product:product.runtime,...realTools()}});
fs.mkdirSync(out,{recursive:true});
const summaries=[];
const terminal=task=>['completed','failed','interrupted','canceled'].includes(task?.status);
function parent(session,key){return t.runtime.store.withTx(()=>{t.runtime.store.setSessionQueueState(session.id,'paused','text-audit');const task=t.runtime.store.insertQueuedTask({sessionId:session.id,requestId:key,input:'拥有者授权读取',modelSelection:t.runtime.defaultSelection,submissionDigest:key,accessMode:'full_access'}).task;t.runtime.store.transitionTask(task.id,['queued'],'running');return t.runtime.store.getTask(task.id);});}
function capture(taskId,start,end){
 const task=t.runtime.store.getTask(taskId);assert.equal(task.status,'completed',JSON.stringify(task));
 const records=t.runtime.store.listSelectionRecordsByTask(taskId);assert.ok(records.length);
 for(const record of records){const snapshot=JSON.parse(t.runtime.artifacts.read(record.promptArtifactId,0,4*1024*1024).toString());const file=`after-${identity}-${record.callIndex}.prompt.json`;fs.writeFileSync(path.join(out,file),JSON.stringify(snapshot,null,2)+'\n');summaries.push({identity,callIndex:record.callIndex,toolSchemas:record.estimates.toolSchemas,systemPrompt:record.estimates.systemPrompt,tools:snapshot.tools.map(tool=>tool.name),snapshot:file});}
 fs.writeFileSync(path.join(out,`after-${identity}-provider.json`),JSON.stringify(t.server.calls.slice(start,end),null,2)+'\n');
}
try{
 const rt=t.runtime,session=await rt.createSession({projectName:'identity-audit',cwd:t.work[0]});
 await t.client.request('mcp_configure',{name:'text',endpoint:mcp.url,credential:null,tool_allowlist:['capture']});
 const sourceTask=parent(session,'ordinary-source'),start=t.server.calls.length;
 const child=await rt.subagents.delegate({parentTaskId:sourceTask.id,key:'ordinary',request:'读取当前MCP对象',paramsDigest:'ordinary-text-audit'});
 await waitFor('普通子任务完成',()=>terminal(rt.store.getTask(child.task.id)));
 capture(child.task.id,start,t.server.calls.length);
 rt.store.withTx(()=>rt.store.endTask(sourceTask.id,['running'],'completed'));
 identity='code-workflow-direct';phase=0;
 const workflowSource=parent(session,'workflow-source'),workflowStart=t.server.calls.length;
 const run=rt.workflows.start({sourceTaskId:workflowSource.id,requestKey:'workflow-direct',input:null,script:'return await agent("capture",{request:"读取当前MCP对象并报告",tools:["mcp__text__capture"]});'});
 rt.store.withTx(()=>rt.store.endTask(workflowSource.id,['running'],'completed'));
 await waitFor('具名MCP工作流完成',()=>['succeeded','failed','partial','paused'].includes(requireWorkflowRun(rt.store,run.id).status));
 assert.equal(requireWorkflowRun(rt.store,run.id).status,'succeeded',JSON.stringify(requireWorkflowRun(rt.store,run.id)));
 const execution=listWorkflowExecutions(rt.store,run.id).find(execution=>execution.kind==='agent');assert.ok(execution);
 capture(execution.taskId,workflowStart,t.server.calls.length);
 assert.equal(mcp.hits.filter(hit=>hit.rpcMethod==='tools/call').length,2);
 fs.writeFileSync(path.join(out,'after-code-identities-summary.json'),JSON.stringify(summaries,null,2)+'\n');
 console.log(JSON.stringify(summaries));
}finally{await t.shutdown();await mcp.close();}
