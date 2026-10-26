import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const [source, out, stage, flavor = 'mock'] = process.argv.slice(2);
const req = createRequire(path.join(source, 'package.json'));
const sdkPkg = path.join(source, 'node_modules/@earendil-works/pi-coding-agent/package.json');
const version = JSON.parse(fs.readFileSync(sdkPkg, 'utf8')).version;
const from = name => import(pathToFileURL(path.join(source, name)).href);
const { startTestRuntime, createProjectSession, waitFor, realTools } = await from('test/helpers/testkit.ts');
const { startMockMcp } = await from('test/helpers/mock-mcp.ts');
const { product } = await from('apps/ruukoto-code/src/product.ts');
const searchName = version === '0.85.1' ? 'search_tools' : 'tool_search';
const callName = version === '0.85.1' ? 'mcp_mock_capture' : 'mcp__mock__capture';
let phase = 0;
const mcp = await startMockMcp({tools:[{name:'capture',description:'只读查询',result:{content:[{type:'text',text:'原服务结果'}]}},{name:'put',description:'写入资料'}]});
const t = await startTestRuntime('text-snapshot', (_request,index)=> {
  if(phase === 0) {phase++;return {kind:'tool_calls',calls:[{id:'discover',name:searchName,arguments:{query:'capture',limit:1}}]};}
  if(phase === 1) {phase++;return {kind:'tool_calls',calls:[{id:'invoke',name:callName,arguments:{}}]};}
  return {kind:'text',text:'完成'};
}, {config:{product:product.runtime,...(flavor === 'real' ? realTools() : {})}});
fs.mkdirSync(out,{recursive:true});
const summary=[];
try {
  const {sessionId}=await createProjectSession(t.client,t.work[0]);
  await t.client.request('mcp_configure',{name:'mock',endpoint:mcp.url,credential:null,tool_allowlist:['capture',{name:'put',effect:'write'}]});
  for(const mode of ['confirm','plan']) {
    phase = mode === 'confirm' ? 0 : 2;
    const task=await t.runtime.submit({sessionId,requestId:mode,input:mode === 'confirm' ? '查询资料' : '规划资料',modelSelection:t.runtime.defaultSelection,accessMode:mode});
    await waitFor('任务终结',()=>['completed','failed','interrupted','canceled'].includes(t.runtime.store.getTask(task.id).status));
    const done=t.runtime.store.getTask(task.id); assert.equal(done.status,'completed',JSON.stringify(done));
    const records=t.runtime.store.listSelectionRecordsByTask(task.id);
    for(const record of records) {
      const snapshot=JSON.parse(t.runtime.artifacts.read(record.promptArtifactId,0,4*1024*1024).toString());
      const name=`${stage}-${flavor}-${mode}-${record.callIndex}`;
      fs.writeFileSync(path.join(out,name+'.prompt.json'),JSON.stringify(snapshot,null,2)+'\n');
      summary.push({stage,version,flavor,identity:'code-dev',accessMode:mode,callIndex:record.callIndex,systemPrompt:record.estimates.systemPrompt,toolSchemas:record.estimates.toolSchemas,toolCount:snapshot.tools.length,searchName,search:snapshot.tools.find(tool=>tool.name===searchName),snapshot:name+'.prompt.json'});
    }
  }
  fs.writeFileSync(path.join(out,`${stage}-${flavor}-provider.json`),JSON.stringify(t.server.calls,null,2)+'\n');
  fs.writeFileSync(path.join(out,`${stage}-${flavor}-summary.json`),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify(summary.map(({search,...rest})=>rest)));
} finally {await t.shutdown();await mcp.close();}
