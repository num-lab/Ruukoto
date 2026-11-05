import { test } from "node:test";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { DesktopError } from "../apps/desktop/src/main/environment.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { PersonalController } from "../apps/desktop/src/main/personal-controller.ts";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import { savePersonalConfig, loadPersonalConfig, personalPendingFile, writePersonalRecord } from "../apps/desktop/src/main/personal-config.ts";
import { PersonalRemoteAuth } from "../apps/ruukoto/src/personal-remote-auth.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { desktopRemoteFixture, waitFor } from "./helpers/personal-remote-desktop.ts";
import { personalTestKey, personalTestCertificate } from "./helpers/personal-https.ts";

const expected = (code: string) => (error: unknown) => (error instanceof ControlClientError || error instanceof DesktopError) && error.code === code;
test('A10：已有绑定重配，安全存储成功但本机绑定保存失败后应可用原候选恢复',async t=>{
 const f=await desktopRemoteFixture(t), original=f.create();
 await original.pair('ABCDEFGHIJKL','Original'); await original.close();
 const oldConfig=loadPersonalConfig(f.directory)!;
 f.state.handshakeProfile=`sha256:${'b'.repeat(64)}`;
 const pairing=f.create();
 const rename=fs.renameSync;
 const mock=t.mock.method(fs,'renameSync',(from:fs.PathLike,to:fs.PathLike)=>{
  if(String(to)===path.join(f.directory,'personal-remote.json'))throw Object.assign(new Error('isolated binding save failed'),{code:'EIO'});
  return rename(from,to);
 });syncBuiltinESMExports();
 try {await assert.rejects(pairing.pair('MNOPQRSTUVWX','Repaired'));}
 finally{mock.mock.restore();syncBuiltinESMExports();}
 const saved=JSON.parse(f.state.raw!);
 assert.equal(saved.active.profile.id,oldConfig.binding!.profile.id); assert.ok(saved.candidate);
 assert.deepEqual(loadPersonalConfig(f.directory),oldConfig);
 await pairing.close();
 const reopened=f.create();await reopened.reconnect();
 assert.equal(reopened.status.state,'online','原凭据已登记且仍持秘密，绑定保存失败不应永久拒绝恢复');
});


test('A3：迟到的旧输入查询不能清除后续新输入的未决记录',async t=>{
 const f=await desktopRemoteFixture(t),controller=f.create();await controller.pair('ABCDEFGHIJKL','test');
 f.state.dropInput=true;const old=await controller.submitInput('old input');assert.equal(old.kind,'pending');
 const releases:(()=>void)[]=[];
 f.overrides.set('/input',async(_req,res)=>{await new Promise<void>(resolve=>releases.push(resolve));f.respond(res,{status:'queued'});});
 const first=controller.reconcileInput(),late=controller.reconcileInput();
 await waitFor(()=>releases.length===2);releases[0]();await first;
 const next=await controller.submitInput('new input');assert.equal(next.kind,'pending');
 const file=personalPendingFile(f.directory,controller.config);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).input.requestId,next.requestId);
 releases[1]();await late;
 const current=JSON.parse(fs.readFileSync(file,'utf8')).input;
 assert.equal(current?.requestId,next.requestId,'旧请求回执只能清理相同requestId，不能删除新待核实输入');
});


test('A10：原候选确认未登记后，用户应能用正确的新配对码完成配对',async t=>{
 let origin='',raw:string|null=null,authorization:string|null=null,pairCalls=0;
 const identity={v:1,product:'ruukoto',origin:'',remoteId:randomUUID(),profile:{id:`sha256:${'a'.repeat(64)}`,directory:'/test/personal'},online:false};
 const server=https.createServer({key:personalTestKey,cert:personalTestCertificate},(req,res)=>{void(async()=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const reply=(ok:boolean,result:unknown,code?:string)=>res.writeHead(ok?200:401,{'content-type':'application/json'}).end(JSON.stringify({v:1,product:'ruukoto',ok,...(ok?{result}:{code,message:'isolated rejection'})}));
  if(req.url==='/pair'){pairCalls++;const body=JSON.parse(Buffer.concat(chunks).toString());if(body.code!=='BBBBBBBBBBBB'){reply(false,null,'remote_pairing_rejected');return;}authorization=String(req.headers.authorization);reply(true,{status:'active'});return;}
  if(req.url==='/handshake'&&req.headers.authorization===authorization){reply(true,{...identity,origin});return;}reply(false,null,'remote_credential_invalid');
 })().catch(()=>res.destroy());});
 server.listen(0,'127.0.0.1');await once(server,'listening');origin=`https://127.0.0.1:${(server.address()as{port:number}).port}`;
 const directory=fs.realpathSync(fs.mkdtempSync('/tmp/review-pair-retry-')),agent=new https.Agent({ca:personalTestCertificate});
 const controller=new PersonalController({v:1,origin},directory,()=>{},{read:async()=>raw,write:async value=>{raw=value;},remove:async()=>{raw=null;}},{agent});
 t.after(async()=>{await controller.close();agent.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(directory,{recursive:true,force:true});});
 await assert.rejects(controller.pair('AAAAAAAAAAAA','test'),expected('remote_pairing_rejected'));
 await assert.rejects(controller.reconcilePairing(),expected('remote_credential_invalid'));
 let retryError:string|undefined;
 try{await controller.pair('BBBBBBBBBBBB','test');}catch(error){retryError=error instanceof ControlClientError?error.code:'unexpected_error';}
 assert.equal(retryError,undefined,'已确认未登记后，更正配对码不应被原candidate永久阻断');assert.equal(pairCalls,2);
});


test('A10：系统存储等待中的原配对不能与地址切换交错',async()=>{
 const directory=fs.realpathSync(fs.mkdtempSync('/tmp/review-switch-pair-'));let raw:string|null=null,queue:Promise<unknown>=Promise.resolve(),armed=false,readEntered=false,writeEntered=false;
 let releaseRead!:()=>void,releaseWrite!:()=>void;const readGate=new Promise<void>(r=>releaseRead=r),writeGate=new Promise<void>(r=>releaseWrite=r);
 const serial=<T>(op:()=>Promise<T>)=>{const result=queue.then(op);queue=result.then(()=>undefined,()=>undefined);return result;};
 const storage={read:()=>serial(async()=>{if(armed&&!readEntered){readEntered=true;await readGate;}return raw;}),write:(value:string)=>serial(async()=>{writeEntered=true;await writeGate;raw=value;}),remove:()=>serial(async()=>{raw=null;})};
 savePersonalConfig(directory,{origin:'https://original.invalid'});
 const host=new DesktopHost(process.cwd(),directory,{publish(){},focused:()=>false,notice(){},badge(){},credentials:storage},async()=>({node:process.execPath,env:process.env}));
 await host.request('personal','reconnect',{});armed=true;
 const pairing=host.request('personal','desktop_personal_pair',{code:'AAAAAAAAAAAA',label:'test'});await waitFor(()=>readEntered);
 const switching=host.request('personal','desktop_personal_config_save',{origin:'https://new.invalid'});releaseRead();
 try{
  await waitFor(()=>writeEntered);await new Promise(r=>setTimeout(r,30));
  const current=loadPersonalConfig(directory)!;
  assert.equal(current.origin,'https://original.invalid','原配对未核实前必须拒绝切换，否则旧origin candidate会在新配置落盘后出现');
 }finally{const closing=host.close();releaseWrite();await Promise.all([pairing,switching,closing]);fs.rmSync(directory,{recursive:true,force:true});}
});


test('A10：地址切换已经开始安全存储核实时，不能启动原地址配对',async()=>{
 const directory=fs.realpathSync(fs.mkdtempSync('/tmp/review-pair-switch-'));let raw:string|null=null,queue:Promise<unknown>=Promise.resolve(),armed=false,readEntered=false,writes=0;
 let releaseRead!:()=>void;const readGate=new Promise<void>(r=>releaseRead=r);
 const serial=<T>(op:()=>Promise<T>)=>{const result=queue.then(op);queue=result.then(()=>undefined,()=>undefined);return result;};
 const storage={read:()=>serial(async()=>{if(armed&&!readEntered){readEntered=true;await readGate;}return raw;}),write:(value:string)=>serial(async()=>{writes++;raw=value;}),remove:()=>serial(async()=>{raw=null;})};
 savePersonalConfig(directory,{origin:'https://original.invalid'});
 const host=new DesktopHost(process.cwd(),directory,{publish(){},focused:()=>false,notice(){},badge(){},credentials:storage},async()=>({node:process.execPath,env:process.env}));
 await host.request('personal','reconnect',{});armed=true;
 const switching=host.request('personal','desktop_personal_config_save',{origin:'https://new.invalid'});await waitFor(()=>readEntered);
 const pairing=host.request('personal','desktop_personal_pair',{code:'AAAAAAAAAAAA',label:'test'});
 try{
  const result=await pairing;
  assert.equal(result.ok,false);
  assert.equal(result.ok===false&&result.error.code,'personal_pairing_busy');
  assert.equal(writes,0,'切换占用生效后不得写入旧地址候选');
  releaseRead();await switching;
  assert.equal(loadPersonalConfig(directory)!.origin,'https://new.invalid');
 }finally{releaseRead();await Promise.all([pairing,switching,host.close()]);fs.rmSync(directory,{recursive:true,force:true});}
});


test('A10/A11：丢答候选被服务器明确撤销后，显式新配对应换新凭据而不重放激活旧ID',async t=>{
 const home=fs.realpathSync(fs.mkdtempSync('/tmp/review-revoked-pair-'));fs.chmodSync(home,0o700);
 const userData=home+'/desktop';fs.mkdirSync(userData,{mode:0o700});
 const owner='owner@example',profile={id:'sha256:'+'a'.repeat(64),directory:home+'/profile'};
 let auth:PersonalRemoteAuth,origin='',raw:string|null=null,drop=true,pairs=0;
 const server=https.createServer({key:personalTestKey,cert:personalTestCertificate},(req,res)=>{void(async()=>{
  const respond=(result:unknown)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({v:1,product:'ruukoto',ok:true,result}));
  try{
   if(req.url==='/pair'){
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    pairs++;const result=auth.pair(owner,req.headers.authorization,JSON.parse(Buffer.concat(chunks).toString()));
    if(drop){drop=false;req.socket.destroy();return;}respond(result);return;
   }
   auth.authenticate(owner,req.headers.authorization);
   if(req.url==='/handshake'){const identity=auth.identity();respond({v:1,product:'ruukoto',origin,remoteId:identity.remoteId,profile,online:false});return;}
   throw new Error('unexpected route');
  }catch(error){if(!(error instanceof PersonalError))throw error;res.writeHead(401,{'content-type':'application/json'}).end(JSON.stringify({v:1,product:'ruukoto',ok:false,code:error.code,message:error.message}));}
 })().catch(error=>res.destroy(error));});
 server.listen(0,'127.0.0.1');await once(server,'listening');origin='https://127.0.0.1:'+(server.address() as {port:number}).port;
 auth=new PersonalRemoteAuth({origin,owner,profile},{initialize:true,home:()=>home});
 const storage={read:async()=>raw,write:async(value:string)=>{raw=value;},remove:async()=>{raw=null;}};
 const agent=new https.Agent({ca:personalTestCertificate});const controller=new PersonalController({v:1,origin},userData,()=>{},storage,{agent});
 t.after(async()=>{await controller.close();agent.destroy();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));auth.close();fs.rmSync(home,{recursive:true,force:true});});
 await assert.rejects(controller.pair(auth.openPairing().code,'Original'));
 const originalId=JSON.parse(raw!).candidate.id;auth.revoke(originalId);
 await assert.rejects(controller.reconcilePairing(),(error:unknown)=>error instanceof ControlClientError&&error.code==='remote_credential_revoked');
 await assert.rejects(controller.restorePairing(),expected('remote_credential_revoked')); assert.equal(pairs,1);
 let retryError:string|undefined;try{await controller.pair(auth.openPairing().code,'Replacement');}catch(error){retryError=error instanceof ControlClientError?error.code:'unexpected_error';}
 assert.equal(retryError,undefined,'服务器已明确撤销候选，显式新配对应能生成新ID，不能永久困在旧候选');
 const saved=JSON.parse(raw!);assert.notEqual(saved.active.id,originalId);assert.equal(auth.list().length,2);assert.equal(auth.list()[0].status,'revoked');
});

test("配对未知不更换参数，显式恢复从安全槽原样发送，已知拒绝后可沿同ID更正", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); f.state.dropPairBeforeAdmission = true;
  await assert.rejects(controller.pair("AAAAAAAAAAAA", "Original"), expected("personal_connection_lost"));
  const original = JSON.parse(f.state.raw!).candidate;
  await assert.rejects(controller.pair("BBBBBBBBBBBB", "Corrected"), expected("personal_pairing_pending"));
  assert.equal(f.state.pairCalls, 1); assert.deepEqual(JSON.parse(f.state.raw!).candidate, original);
  f.state.dropPairBeforeAdmission = false; f.state.rejectPair = true;
  await assert.rejects(controller.restorePairing(), (error: unknown) => expected("remote_pairing_rejected")(error) && !!error && typeof error === "object" && "outcome" in error && error.outcome === "rejected");
  assert.deepEqual(f.state.pairCodes, ["AAAAAAAAAAAA", "AAAAAAAAAAAA"]);
  const rejected = JSON.parse(f.state.raw!).candidate; assert.equal(rejected.rejected, true); assert.equal(rejected.id, original.id); assert.equal(rejected.secret, original.secret);
  f.state.rejectPair = false; await controller.pair("BBBBBBBBBBBB", "Corrected");
  const saved = JSON.parse(f.state.raw!); assert.equal(saved.candidate, undefined); assert.equal(saved.active.id, original.id); assert.equal(saved.active.secret, original.secret);
  assert.deepEqual(f.state.pairCodes, ["AAAAAAAAAAAA", "AAAAAAAAAAAA", "BBBBBBBBBBBB"]);
});

test("候选被拒绝不覆盖既有active，新凭据可在原输入待核实时完成同档案授权", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair("AAAAAAAAAAAA", "Original");
  const active = JSON.parse(f.state.raw!).active;
  f.state.rejectPair = true;
  await assert.rejects(controller.pair("BBBBBBBBBBBB", "Replacement"), expected("remote_pairing_rejected"));
  assert.deepEqual(JSON.parse(f.state.raw!).active, active);
  f.state.rejectPair = false; f.state.dropInput = true;
  const input = await controller.submitInput("原输入仍应按原键核实"); assert.equal(input.kind, "pending");
  await controller.pair("CCCCCCCCCCCC", "Replacement");
  assert.notEqual(JSON.parse(f.state.raw!).active.id, active.id); assert.equal(f.state.inputCalls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, controller.config), "utf8")).input, null);
});

test('A3/A10：允许同档案重新授权时，有原未决输入仍不能借配对改绑新档案',async t=>{
 const f=await desktopRemoteFixture(t),controller=f.create();await controller.pair('AAAAAAAAAAAA','Original');
 f.state.dropInput=true;const input=await controller.submitInput('尚未核实的原输入');assert.equal(input.kind,'pending');
 const original=loadPersonalConfig(f.directory)!,pendingPath=personalPendingFile(f.directory,original);
 f.state.handshakeProfile='sha256:'+'b'.repeat(64);
 await assert.rejects(controller.pair('BBBBBBBBBBBB','Replaced'),expected('personal_pending'));
 const current=loadPersonalConfig(f.directory)!;
 assert.equal(current.binding!.profile.id,original.binding!.profile.id,'原请求未决时不得改绑档案并把原请求从当前待核实入口隐藏');
 assert.equal(JSON.parse(fs.readFileSync(pendingPath,'utf8')).input.requestId,input.requestId);
 assert.ok(JSON.parse(f.state.raw!).candidate,'保持候选以便先核实原请求，再恢复已登记配对');
});

test("Native action intent is durable before send and only its exact receipt unlocks it after restart", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair("AAAAAAAAAAAA", "Original");
  const action: import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction = { v: 1, requestId: randomUUID(), family: "questions", operation: 42, admission: 60, occurrence: 60, action: "answer", questionVersion: 1, answers: [{ text: "Exact owner answer" }] };
  let posts = 0, committed = false, mismatch = false;
  f.overrides.set("/desktop/action", async (req, res, value) => {
    if (req.method === "POST") {
      posts++; const pending = JSON.parse(fs.readFileSync(personalPendingFile(f.directory, controller.config), "utf8")); assert.deepEqual(pending.actions, [action]); assert.deepEqual(value, action);
      req.socket.destroy(); return;
    }
    f.respond(res, committed ? { v: 1, request: mismatch ? { ...action, admission: 999 } : action, entry: 80, state: "completed" } : null);
  });
  await assert.rejects(controller.business("POST", "/desktop/action", action), expected("personal_connection_lost"));
  assert.equal(posts, 1); await assert.rejects(controller.business("POST", "/desktop/action", { ...action, requestId: randomUUID() }), expected("personal_action_pending"));
  await assert.rejects(controller.assertSwitchable(), expected("personal_pending")); await controller.close();
  const reopened = f.create(); await reopened.reconnect(); assert.equal(posts, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, reopened.config), "utf8")).actions, [action]);
  assert.ok(f.updates.some(update => update.type === "personal_actions" && update.items[0]?.requestId === action.requestId));
  committed = true; mismatch = true;
  await assert.rejects(reopened.business("GET", `/desktop/action?requestId=${action.requestId}`), expected("personal_protocol"));
  assert.deepEqual(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, reopened.config), "utf8")).actions, [action]);
  mismatch = false; await reopened.business("GET", `/desktop/action?requestId=${action.requestId}`);
  assert.equal(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, reopened.config), "utf8")).actions, undefined); assert.equal(posts, 1);
});

test("Native recovery rejects client source fields and stale choices clear only their own unsent intent", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair("AAAAAAAAAAAA", "Original");
  const action: import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction = { v: 1, requestId: randomUUID(), family: "browser", operation: 55, admission: 70, occurrence: 70, action: "resume" };
  let posts = 0;
  f.overrides.set("/desktop/action", async (req, res) => { assert.equal(req.method, "POST"); posts++; f.reject(res, "desktop_action_stale", 409); });
  await assert.rejects(controller.business("POST", "/desktop/action", { ...action, actor: { kind: "native", credential: "fake" } }), expected("personal_action_invalid")); assert.equal(posts, 0);
  await assert.rejects(controller.business("POST", "/desktop/action", action), (error: unknown) => expected("desktop_action_stale")(error) && error instanceof ControlClientError && error.outcome === "rejected");
  assert.equal(posts, 1); assert.equal(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, controller.config), "utf8")).actions, undefined);
  const release = await controller.assertSwitchable(); release();
});

test("Native stream parsing accepts bounded all-family cards and questions and rejects unknown card actions", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair("AAAAAAAAAAAA", "Original"); await waitFor(() => f.updates.some(update => update.type === "personal_frame"));
  const snapshot = f.updates.findLast(update => update.type === "personal_frame" && update.frame.type === "snapshot"); assert.ok(snapshot?.type === "personal_frame");
  const card = { family: "mcp", operation: 42, occurrence: 60, admission: 60, kind: "cua", target: "Original computer", targetTruncated: false, approval: "approved", observed: true, started: true, stopped: false, effect: "effect_unknown", code: "interrupted", canDecide: false, actions: ["cleanup", "stop_sandbox"] };
  const question = { id: "43", admission: 61, occurrence: 61, version: 1, status: "pending", question: "Which original work?", canAnswer: true, canCancel: true, work: 44 };
  const state = { v: 1, revision: 1, approvals: { items: [card], total: 1 }, questions: { items: [question], total: 1 }, works: { items: [], total: 0 }, delegations: { items: [], total: 0 } };
  for (const ws of f.wss.clients) ws.send(JSON.stringify({ v: 1, runId: f.runId, subscription: snapshot.frame.subscription, seq: 1, type: "events", events: [{ type: "personal_state", state }] }));
  await waitFor(() => f.updates.some(update => update.type === "personal_frame" && update.frame.seq === 1)); assert.equal(controller.status.state, "online");
  for (const ws of f.wss.clients) ws.send(JSON.stringify({ v: 1, runId: f.runId, subscription: snapshot.frame.subscription, seq: 2, type: "events", events: [{ type: "personal_state", state: { ...state, approvals: { items: [{ ...card, actions: ["arbitrary_write"] }], total: 1 } } }] }));
  await waitFor(() => controller.status.state === "failed"); assert.equal(controller.status.error?.code, "personal_protocol");
});

test("Native original-operation reads clear only the matching family's pending legacy decision", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair("AAAAAAAAAAAA", "Original");
  const file = personalPendingFile(f.directory, controller.config), operation = 77;
  writePersonalRecord(file, { v: 1, input: null, decisions: [{ kind: "services", operation, decision: "approved" }] });
  f.overrides.set("/desktop/operation", async (req, res) => {
    const family = new URL(req.url!, f.origin).searchParams.get("family")!, admission = family === "services" ? 100 : 101;
    const summary = { family, operation, admission, occurrence: admission, kind: family === "services" ? "service_restart" : "service_inspect", target: "original.service", targetTruncated: false, approval: family === "services" ? "approved" : "unneeded", observed: true, started: true, stopped: true, effect: "no_write", code: "completed", canDecide: false, actions: [] };
    f.respond(res, { v: 1, revision: 1, operation, admission, summary, text: "{}", offset: 0 });
  });
  await controller.business("GET", `/desktop/operation?family=inspections&operation=${operation}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).decisions, [{ kind: "services", operation, decision: "approved" }]);
  await controller.business("GET", `/desktop/operation?family=services&operation=${operation}`);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).decisions, undefined);
});
