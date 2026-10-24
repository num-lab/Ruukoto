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
import { savePersonalConfig, loadPersonalConfig, personalPendingFile } from "../apps/desktop/src/main/personal-config.ts";
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
