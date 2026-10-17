import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openPersonalHarness } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-harness.ts';
import { PersonalCommandDoc, resolvePersonalCommand } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-command-work.ts';
import { savePersonalCommands } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-command-config.ts';
import { personalProvider } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-model.ts';
import { readPersonalCommandReceipt, stopPersonalCommand } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-command-execution.ts';
import { PersonalPermissionsDoc } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-permissions.ts';
import { MockModelServer } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/helpers/mock-provider.ts';

const context=BACKGROUND_CONTEXT, self=process.argv[1], mode=process.argv[2], base=process.argv[3];
const sha=value=>createHash('sha256').update(value).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label,timeout=30000){const end=Date.now()+timeout;while(!await check()){assert.ok(Date.now()<end,`timeout: ${label}`);await sleep(25);}}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`timeout: ${label}`)),30000);})]);}finally{clearTimeout(timer);}}
const commandRecord=(f,op)=>path.join(f.profile,'commands',`command-${op.execution.executionId}`);

async function owner(f,restore=false){
  const secret=randomBytes(24).toString('hex');
  const controls=['RUUKOTO_OWNER_TOKEN','RUUKOTO_OWNER_TOKEN_FILE','RUUKOTO_CONTROL_DIR','RUUKOTO_CODE_CONTROL_DIR'];
  process.env.RUUKOTO_FULL_SYNTHETIC_SECRET=secret;
  for(const key of controls)process.env[key]='synthetic-internal-control';
  process.env.PATH='/synthetic-full-26:'+process.env.PATH;
  let networkCount=0;
  const network=createServer((req,res)=>{networkCount++;res.writeHead(200);res.end('full-network-ok');});
  await new Promise(resolve=>network.listen(0,'127.0.0.1',resolve));
  process.env.RUUKOTO_FULL_TEST_URL='http://127.0.0.1:'+network.address().port;
  process.env.RUUKOTO_FULL_TEST_OUTSIDE=path.join(f.root,'outside-result.json');
  process.env.RUUKOTO_FULL_TEST_HEARTBEAT=path.join(f.root,'heartbeat');

  const server=new MockModelServer(request=>request.system?.includes('你是个人助手的子 Agent')&&request.messages.at(-1)?.content==='执行命令'
    ?{kind:'tool_calls',calls:[{id:'command',name:'run_command',arguments:{command:f.command}}]}:{kind:'text',text:'完成'});
  const model={api:'openai-completions',baseUrl:await server.start(),modelId:'mock-model',apiKeyEnv:'RUUKOTO_COMMAND_LINUX_TEST_KEY',contextWindow:128000,maxTokens:1024};
  process.env[model.apiKeyEnv]='test-only';
  if(f.name==='restricted')f.command=f.command.replaceAll('__TEST_ROOT__',f.root).replaceAll('__TEST_URL__',process.env.RUUKOTO_FULL_TEST_URL);
  let crashArmed=f.name==='receipt-before-observation'&&!restore;
  const options={directory:f.profile,commands:f.config,provider:personalProvider(model),modelId:model.modelId,
    openStorage:async filename=>{
      const storage=await openNodeSqliteStorage(filename),commit=storage.commit.bind(storage);
      storage.commit=async(writes,ctx)=>{
        if(crashArmed&&JSON.stringify(writes).includes('"ruukoto.command-observation"')){
          crashArmed=false;
          const page=await storage.scanDocuments({kind:'ruukoto.command',scope:{kind:'session'},at:'current'},16,undefined,context);
          assert.equal(page.items.length,1);
          const op=(await storage.document(page.items[0].id,'current',context)).value.command;
          const receipt=await readPersonalCommandReceipt(path.join(f.profile,'commands'),op.execution,op.prepared.fingerprint);
          assert.ok(receipt,'receipt must exist before injected durable commit crash');
          write(path.join(f.root,'command-state.json'),op);write(path.join(f.root,'work.json'),op.work.ref);
          write(path.join(f.root,'injected-crash.json'),{pid:process.pid,receipt,prepared:op.prepared,op});
          process.kill(process.pid,'SIGKILL');
        }
        return commit(writes,ctx);
      };
      return storage;
    }};
  let p;
  try{
    if(!restore)await savePersonalCommands(f.profile,f.config);
    p=await openPersonalHarness(options);
    if(!restore)await p.harness.commit(async tx=>{(await tx.doc(PersonalPermissionsDoc)).mode=f.name==='restricted'?'confirm':'full_access';},context);
    let work,ref;
    if(!restore){
      await p.answer('拥有者明确委派的测试命令','owner-source');
      work=await p.work.delegate({requestId:'linux-original-work',sourceRequestId:'owner-source',content:'执行命令'});
      write(path.join(f.root,'work.json'),work);
      await until(async()=>{const values=(await p.commands.list()).items;if(!values.length)return false;ref=values[0].ref;return true;},'command admission');
      await until(async()=>{const op=(await p.harness.snapshot(PersonalCommandDoc,ref.requestId,context)).command;if(!op.started)return false;write(path.join(f.root,'command-state.json'),op);return true;},'persisted start');
      if(f.name==='cancel-full'){
        await until(()=>fs.existsSync(path.join(f.workspace,'count'))&&fs.existsSync(path.join(f.root,'heartbeat')),'cancel after real external effect');
        const canceled=p.work.cancel(work);
        await until(async()=>{const detail=await p.commands.detail(ref,'stdout');return detail.result?.effect==='effect_unknown'&&detail.result.code!=='started'&&detail.stopped;},'cancel original execution stopped but effect unknown');
        assert.deepEqual((await p.work.list()).find(agent=>agent.id===work.agentId).work,work);
        assert.equal(await p.answer('独立聊天继续','independent'),'完成');
        const heartbeat=fs.readFileSync(path.join(f.root,'heartbeat'),'utf8');await sleep(200);assert.equal(fs.readFileSync(path.join(f.root,'heartbeat'),'utf8'),heartbeat);
        write(path.join(f.root,'cancel-before-resolution.json'),{detail:await p.commands.detail(ref,'stdout'),agents:await p.work.list(),heartbeatFrozen:true});
        await p.harness.commit(tx=>resolvePersonalCommand(tx,ref,'applied','原专属count仅一行x，取消后原setsid心跳已冻结。'),context);
        assert.equal((await bounded(canceled,'canceled work released')).state.outcome.status,'aborted');
      }else if(!['normal','restricted'].includes(f.name)){
        await until(()=>false,'external SIGKILL',120000);
      }
    }else{
      work=read(path.join(f.root,'work.json'));ref=read(path.join(f.root,'command-state.json')).ref;
      const detail=await p.commands.detail(ref,'stdout');
      write(path.join(f.root,'restore-initial.json'),{detail,agents:await p.work.list(),calls:server.calls.length});
      assert.equal(fs.readFileSync(path.join(f.workspace,'count'),'utf8'),'x\n');
      if(f.name==='receipt-before-observation'){
        assert.equal(detail.result.effect,'returned');assert.equal(detail.result.exitCode,37);
      }else{
        assert.equal(detail.result.effect,'effect_unknown');assert.notEqual(detail.result.code,'started');
        assert.deepEqual((await p.work.list()).find(agent=>agent.id===work.agentId).work,work);
        const before=fs.readFileSync(path.join(f.workspace,'count'),'utf8');
        assert.equal(await p.answer('独立聊天继续','independent'),'完成');
        await p.harness.commit(tx=>resolvePersonalCommand(tx,ref,'applied','独立读取专用工作目录 count，原效果只有一行 x。'),context);
        if(f.name==='stop-unverified'){
          assert.equal(detail.stopped,false);
          await p.harness.waitForTask(await p.commands.stop(ref),context);
          const unverified=await p.commands.detail(ref,'stdout');
          assert.equal(unverified.stopped,false);
          assert.deepEqual((await p.work.list()).find(agent=>agent.id===work.agentId).work,work);
          write(path.join(f.root,'stop-unverified-observed.json'),{detail:unverified,agents:await p.work.list()});
          await until(()=>fs.existsSync(path.join(f.root,'proof-restored')),'restore original proof');
        }
        await p.harness.waitForTask(await p.commands.stop(ref),context);
        assert.equal((await p.commands.detail(ref,'stdout')).stopped,true,'原私有认领恢复后strict停止必须核实');
        assert.equal(fs.readFileSync(path.join(f.workspace,'count'),'utf8'),before);
      }
    }
    const settled=await bounded(p.harness.waitForTask(work.taskId,context),'original work settles');
    assert.equal(settled.state.outcome.status,f.name==='cancel-full'?'aborted':'completed');
    ref??=(await p.commands.list()).items[0].ref;
    const op=(await p.harness.snapshot(PersonalCommandDoc,ref.requestId,context)).command;
    const nativeTask=await p.harness.commit(tx=>tx.task(ref.taskId),context);
    assert.equal(nativeTask.owner,work.taskId);assert.equal(op.work.permission.mode,f.name==='restricted'?'confirm':'full_access');assert.equal(op.prepared.spec.mode,op.work.permission.mode);if(f.name!=='restricted')assert.deepEqual([op.prepared.input.env,op.prepared.input.mounts,op.prepared.input.runtimeReadRoots,op.prepared.input.toolAliases],[{},[],[],[]]);
    assert.ok(!JSON.stringify(op.prepared).includes(secret));assert.ok(!fs.readFileSync(path.join(commandRecord(f,op),'request.json'),'utf8').includes(secret));
    assert.equal(op.stopped,true);
    assert.equal((await p.work.list()).find(agent=>agent.id===work.agentId).work,undefined);
    const streams={};
    for(const stream of ['stdout','stderr']){
      const chunks=[];let offset=0;
      do{const page=(await p.commands.detail(ref,stream,offset)).output;assert.ok(page);chunks.push(Buffer.from(page.data,'base64'));offset=page.nextOffset??-1;}while(offset>=0);
      const output=Buffer.concat(chunks);streams[stream]={bytes:output.length,sha256:sha(output),base64:output.toString('base64')};
    }
    if(f.name==='normal'){
      const request=server.calls.find(call=>call.system?.includes('你是个人助手的子 Agent'));assert.ok(request?.system.includes('当前工作命令权限：完全访问。'));write(path.join(f.root,'permission-request.json'),request);
      const facts=read(path.join(f.root,'outside-result.json'));
      assert.equal(facts.outsideRead,true);assert.equal(facts.uid,process.getuid());assert.equal(facts.home,process.env.HOME);assert.equal(facts.pathPrefix,true);assert.equal(facts.secretLength,48);assert.deepEqual(facts.controls,controls.map(()=>false));assert.equal(facts.network,'full-network-ok');assert.equal(networkCount,1);
      const beat=fs.readFileSync(path.join(f.root,'heartbeat'),'utf8');await sleep(200);assert.equal(fs.readFileSync(path.join(f.root,'heartbeat'),'utf8'),beat,'setsid heartbeat must stop');
      write(path.join(f.root,'full-access-facts.json'),{...facts,networkCount,heartbeatFrozen:true,secretAbsentFromPrepared:true,secretAbsentFromRequest:true});
      assert.equal(op.result.effect,'returned');assert.equal(op.result.exitCode,37);
      assert.equal(streams.stdout.bytes,7003);assert.equal(streams.stderr.base64,Buffer.from([128,0,90]).toString('base64'));
      assert.ok(fs.readFileSync(path.join(commandRecord(f,op),'stdout')).equals(Buffer.concat([Buffer.alloc(7000),Buffer.from([0,255,65])])));
    }
    if(f.name==='restricted'){
      const facts=read(path.join(f.workspace,'restricted-facts.json'));
      assert.equal(facts.readDenied,true);assert.equal(facts.writeDenied,true);assert.equal(facts.networkDenied,true);assert.equal(facts.secretVisible,false);assert.equal(networkCount,0);assert.equal(fs.existsSync(path.join(f.root,'outside-written')),false);
      write(path.join(f.root,'restricted-facts-verified.json'),{...facts,networkCount});
    }
    const reused=await p.work.delegate({requestId:'linux-reuse',sourceRequestId:'owner-source',content:'只分析，不执行命令',agentId:work.agentId});
    await p.harness.waitForTask(reused.taskId,context);
    assert.equal(reused.agentId,work.agentId);
    assert.equal(fs.readFileSync(path.join(f.workspace,'count'),'utf8'),'x\n');
    write(path.join(f.root,'command-state.json'),op);
    write(path.join(f.root,restore?'restore-result.json':'result.json'),{work,command:op,nativeTask,settled,streams,reused,modelCalls:server.calls});
  }finally{await p?.close();await server.close();await new Promise(resolve=>network.close(resolve));}
}

if(mode==='owner'||mode==='restore'){
  await owner(read(process.argv[4]),mode==='restore');
}else if(mode==='stop'){
  const f=read(process.argv[4]),op=read(path.join(f.root,'command-state.json'));
  const stopped=await stopPersonalCommand(path.join(f.profile,'commands'),op.execution,op.prepared.fingerprint);
  write(path.join(f.root,'independent-stop.json'),stopped);assert.equal(stopped.exited,true);
}else{
  const evidence=path.join(base,process.env.RUUKOTO_FULL_EVIDENCE??'evidence'),fixtures=path.join(base,'fixtures');
  fs.mkdirSync(evidence,{recursive:true});fs.mkdirSync(fixtures,{recursive:true,mode:0o700});
  const environment={timestamp:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,uid:process.getuid(),kernel:execFileSync('uname',['-a'],{encoding:'utf8'}).trim(),bwrap:execFileSync('bwrap',['--version'],{encoding:'utf8'}).trim(),manager:execFileSync('systemctl',['--user','is-system-running'],{encoding:'utf8'}).trim(),cgroupV2:fs.existsSync('/sys/fs/cgroup/cgroup.controllers'),self,probeSha256:sha(fs.readFileSync(self)),noOSMock:true};
  write(path.join(evidence,'environment.json'),environment);
  const states=[],children=[];
  const launch=(f,childMode)=>{
    const child=spawn(process.execPath,[self,childMode,base,f.inputFile],{stdio:['ignore',fs.openSync(path.join(f.root,childMode+'.stdout'),'a'),fs.openSync(path.join(f.root,childMode+'.stderr'),'a')]});
    children.push(child);child.finished=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));return child;
  };
  try{
    for(const name of (process.env.RUUKOTO_FULL_SCENARIOS?.split(',')??['normal','no-receipt-crash','receipt-before-observation','stop-unverified','cancel-full','restricted'])){
      const root=fs.mkdtempSync(path.join(fixtures,name+'-')),workspace=path.join(root,'work'),profile=path.join(root,'profile');fs.mkdirSync(workspace,{mode:0o700});
      const stat=fs.statSync(workspace),config={version:1,workspace,identity:{dev:stat.dev,ino:stat.ino},machineId:fs.readFileSync('/etc/machine-id','utf8').trim(),tmpdir:fs.realpathSync(os.tmpdir())};
      const command=name==='normal'?"/usr/local/bin/node -e 'const fs=require('\\''fs'\\''),http=require('\\''http'\\''),{spawn}=require('\\''child_process'\\'');const keys=['\\''RUUKOTO_OWNER_TOKEN'\\'','\\''RUUKOTO_OWNER_TOKEN_FILE'\\'','\\''RUUKOTO_CONTROL_DIR'\\'','\\''RUUKOTO_CODE_CONTROL_DIR'\\''];http.get(process.env.RUUKOTO_FULL_TEST_URL,res=>{let network='\\'''\\'';res.on('\\''data'\\'',d=>network+=d);res.on('\\''end'\\'',()=>{fs.writeFileSync(process.env.RUUKOTO_FULL_TEST_OUTSIDE,JSON.stringify({uid:process.getuid(),home:process.env.HOME,pathPrefix:process.env.PATH.startsWith('\\''/synthetic-full-26:'\\''),secretLength:process.env.RUUKOTO_FULL_SYNTHETIC_SECRET?.length,outsideRead:fs.readFileSync(require('\\''path'\\'').join(require('\\''path'\\'').dirname(process.env.RUUKOTO_FULL_TEST_OUTSIDE),'\\''outside-readable'\\''),'\\''utf8'\\'')==='\\''outside fixture'\\'',controls:keys.map(k=>process.env[k]!==undefined),network}));const code=\"const fs=require('\\''fs'\\'');fs.appendFileSync(process.env.RUUKOTO_FULL_TEST_HEARTBEAT,'\\''x'\\'');setInterval(()=>fs.appendFileSync(process.env.RUUKOTO_FULL_TEST_HEARTBEAT,'\\''x'\\''),25)\";const child=spawn(process.execPath,['\\''-e'\\'',code],{detached:true,stdio:'\\''ignore'\\''});child.unref();const wait=setInterval(()=>{if(fs.existsSync(process.env.RUUKOTO_FULL_TEST_HEARTBEAT)){clearInterval(wait)}},10);});}).on('\\''error'\\'',e=>{console.error(e);process.exitCode=88});'; printf x >> count; printf '\\n' >> count; head -c 7000 /dev/zero; printf '\\000\\377A'; printf '\\200\\000Z' >&2; exit 37":name==='receipt-before-observation'?"printf 'x\\n' >> count; printf observed; exit 37":"printf 'x\\n' >> count; printf started; sleep 120";
      const actualCommand=name==='cancel-full'?"printf 'x\\n' >> count; /usr/local/bin/node -e 'const fs=require('\\''fs'\\''),{spawn}=require('\\''child_process'\\'');const code=\"const fs=require('\\''fs'\\'');fs.appendFileSync(process.env.RUUKOTO_FULL_TEST_HEARTBEAT,'\\''x'\\'');setInterval(()=>fs.appendFileSync(process.env.RUUKOTO_FULL_TEST_HEARTBEAT,'\\''x'\\''),25)\";spawn(process.execPath,['\\''-e'\\'',code],{detached:true,stdio:'\\''ignore'\\''}).unref();'; printf started; sleep 120":name==='restricted'?"printf 'x\\n' >> count; /usr/local/bin/node -e 'const fs=require('\\''fs'\\''),http=require('\\''http'\\'');let readDenied=false,writeDenied=false;try{fs.readFileSync('\\''__TEST_ROOT__/outside-readable'\\'')}catch{readDenied=true}try{fs.writeFileSync('\\''__TEST_ROOT__/outside-written'\\'','\\''x'\\'')}catch{writeDenied=true}const done=networkDenied=>fs.writeFileSync('\\''restricted-facts.json'\\'',JSON.stringify({readDenied,writeDenied,networkDenied,secretVisible:!!process.env.RUUKOTO_FULL_SYNTHETIC_SECRET}));http.get('\\''__TEST_URL__'\\'',r=>{r.resume();r.on('\\''end'\\'',()=>done(false))}).on('\\''error'\\'',()=>done(true));'":command;
      fs.writeFileSync(path.join(root,'outside-readable'),'outside fixture');
      const f={name,root,workspace,profile,config,command:actualCommand,inputFile:path.join(root,'fixture.json')};write(f.inputFile,f);states.push(f);
      const child=launch(f,'owner');
      if(['normal','cancel-full','restricted'].includes(name)){const exit=await child.finished;assert.equal(exit.code,0,fs.readFileSync(path.join(root,'owner.stderr'),'utf8'));
        if(name==='normal'){
          const copiedProfile=path.join(root,'old-profile');fs.cpSync(profile,copiedProfile,{recursive:true});const protect=dir=>{fs.chmodSync(dir,0o700);for(const entry of fs.readdirSync(dir,{withFileTypes:true}))if(entry.isDirectory())protect(path.join(dir,entry.name));};protect(copiedProfile);
          const oldInput=path.join(root,'old-fixture.json');write(oldInput,{...f,profile:copiedProfile,originalProfile:profile});
          const old=spawn(process.execPath,[path.join(path.dirname(self),'linux-command-probe-old.mjs'),oldInput],{stdio:['ignore',fs.openSync(path.join(root,'old.stdout'),'a'),fs.openSync(path.join(root,'old.stderr'),'a')]});
          const oldExit=await new Promise(resolve=>old.once('close',(code,signal)=>resolve({code,signal})));assert.equal(oldExit.code,0,fs.readFileSync(path.join(root,'old.stderr'),'utf8'));
        }
      }
      else{
        if(name==='receipt-before-observation'){
          const exit=await child.finished;assert.equal(exit.signal,'SIGKILL');assert.ok(fs.existsSync(path.join(root,'injected-crash.json')));
        }else{
          await until(()=>fs.existsSync(path.join(root,'command-state.json'))&&fs.existsSync(path.join(workspace,'count'))&&fs.existsSync(path.join(commandRecord(f,read(path.join(root,'command-state.json'))),'stdout')),'external effect and persisted original reference');
          child.kill('SIGKILL');assert.equal((await child.finished).signal,'SIGKILL');
          const op=read(path.join(root,'command-state.json'));assert.equal(fs.existsSync(path.join(commandRecord(f,op),'receipt.json')),false);
        }
        if(name==='stop-unverified'){
          const stopped=launch(f,'stop');assert.equal((await stopped.finished).code,0,fs.readFileSync(path.join(root,'stop.stderr'),'utf8'));
          const op=read(path.join(root,'command-state.json')),proof=path.join(profile,'commands',op.execution.executionId);
          fs.renameSync(proof,path.join(root,'original-native-claim'));write(path.join(root,'proof-isolation.json'),{proof,why:'真正停止后暂时隔离整个原native认领，不替换OS调用；strict恢复必须保守false且不得创建stop-first认领。'});
        }
        const restored=launch(f,'restore');
        if(name==='stop-unverified'){
          await until(()=>fs.existsSync(path.join(root,'stop-unverified-observed.json')),'retained occupancy without native proof');
          const {proof}=read(path.join(root,'proof-isolation.json'));assert.equal(fs.existsSync(proof),false,'strict恢复不得创建替代认领');fs.renameSync(path.join(root,'original-native-claim'),proof);fs.writeFileSync(path.join(root,'proof-restored'),'restored\n');
        }
        const exit=await restored.finished;assert.equal(exit.code,0,fs.readFileSync(path.join(root,'restore.stderr'),'utf8'));
      }
      fs.cpSync(root,path.join(evidence,name),{recursive:true});
    }
    write(path.join(evidence,'summary.json'),{passed:states.map(f=>f.name),scenarios:states.map(f=>({name:f.name,result:read(path.join(f.root,['normal','cancel-full','restricted'].includes(f.name)?'result.json':'restore-result.json'))}))});
  }catch(error){write(path.join(evidence,'failure.json'),{name:error.name,message:error.message,stack:error.stack});throw error;}
  finally{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await child.finished;}
    const cleanup=[];
    for(const f of states){
      const stateFile=path.join(f.root,'command-state.json');if(!fs.existsSync(stateFile)){cleanup.push({name:f.name,noCommand:true});fs.cpSync(f.root,path.join(evidence,f.name),{recursive:true});fs.rmSync(f.root,{recursive:true});continue;}
      const op=read(stateFile),directory=path.join(f.profile,'commands');
      const isolation=path.join(f.root,'proof-isolation.json');if(fs.existsSync(isolation)){const {proof}=read(isolation);if(!fs.existsSync(proof)&&fs.existsSync(path.join(f.root,'original-native-claim')))fs.renameSync(path.join(f.root,'original-native-claim'),proof);}
      let stop,error;try{stop=await stopPersonalCommand(directory,op.execution,op.prepared.fingerprint);}catch(e){error={name:e.name,code:e.code,message:e.message};}
      const scope=`ruukoto-${op.execution.executionId}.scope`;let unit;
      try{unit=execFileSync('systemctl',['--user','show',scope,'--property=LoadState,ActiveState,ControlGroup,InvocationID'],{encoding:'utf8'}).trim();}catch(e){unit=String(e.stdout??'');}
      cleanup.push({name:f.name,execution:op.execution,scope,stop,error,unit,tempDir:op.prepared?.input.tempDir,tempExists:!!op.prepared&&fs.existsSync(op.prepared.input.tempDir)});
      fs.cpSync(f.root,path.join(evidence,f.name),{recursive:true});
      if(stop?.exited&&!cleanup.at(-1).tempExists)fs.rmSync(f.root,{recursive:true});
    }
    write(path.join(evidence,'cleanup.json'),{cleanup,fixturesRemaining:fs.readdirSync(fixtures)});
    assert.ok(cleanup.every(value=>value.noCommand||value.stop?.exited&&!value.tempExists&&value.unit.includes('LoadState=not-found')),'all original scopes/temp must be stopped and absent');
    assert.deepEqual(fs.readdirSync(fixtures),[]);
  }
}
