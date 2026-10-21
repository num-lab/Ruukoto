import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const tree=fs.realpathSync(process.argv[2]);
const output=fs.realpathSync(process.argv[3]);
const workspace=fs.realpathSync(process.argv[4]);
const {product}=await import(pathToFileURL(path.join(tree,'apps/ruukoto-code/src/product.ts')).href);
const {startTestRuntime,realTools,waitFor}=await import(pathToFileURL(path.join(tree,'test/helpers/testkit.ts')).href);
const t=await startTestRuntime('background-schema-before',()=>({kind:'text',text:'已核对，不调用工具。'}),{workDirs:1,config:{...realTools(),product:product.runtime}});
try {
  const session=await t.runtime.createSession({projectName:'schema-before',cwd:workspace,mode:'full_access'});
  const task=await t.runtime.submit({sessionId:session.id,requestId:'schema-before',input:'只回复“已核对”，不要调用工具，不要修改文件。',modelSelection:t.runtime.defaultSelection});
  await waitFor('SDK首轮请求完成',()=>['completed','failed','interrupted'].includes(t.runtime.store.getTask(task.id)!.status),30000);
  assert.equal(t.runtime.store.getTask(task.id)!.status,'completed');
  assert.equal(t.runtime.store.listToolOpsByTask(task.id).length,0);
  const records=t.runtime.store.listSelectionRecordsByTask(task.id);assert.equal(records.length,1);
  const record=records[0];assert.ok(record.promptArtifactId);
  const artifact=t.runtime.store.getArtifact(record.promptArtifactId)!;
  const bytes=t.runtime.artifacts.read(artifact.id,0,artifact.byteCount);
  const snapshot=JSON.parse(bytes.toString('utf8'));
  fs.writeFileSync(path.join(output,'prompt-snapshot.json'),bytes);
  fs.writeFileSync(path.join(output,'selection-record.json'),JSON.stringify(record,null,2)+'\n');
  const result={commit:'01e9e74457a58473b9df1bbdb876cfc9c207747d',platform:process.platform,node:process.version,product:'coding',accessMode:'full_access',newSession:true,ordinaryOwner:true,workspace,model:snapshot.model,tools:snapshot.tools.map((tool:any)=>tool.name),estimates:{toolSchemas:record.estimates.toolSchemas,systemPrompt:record.estimates.systemPrompt},promptSha256:createHash('sha256').update(bytes).digest('hex'),providerCalls:t.server.calls.length,toolCalls:0};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
  process.stdout.write(JSON.stringify({estimates:result.estimates,toolCount:result.tools.length,providerCalls:result.providerCalls,toolCalls:0,promptSha256:result.promptSha256})+'\n');
}finally{await t.shutdown();}
