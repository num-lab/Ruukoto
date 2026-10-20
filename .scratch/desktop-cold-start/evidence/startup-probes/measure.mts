import * as fs from 'node:fs';
import * as path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { makeTestDirs,cleanupDirs,writeModelsJson } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/test/helpers/testkit.ts';
import { MockModelServer } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/test/helpers/mock-provider.ts';
import { ControlClient } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/packages/control/src/client.ts';
import { ControlConnection } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/packages/control/src/connection.ts';
import { ensureBackend } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/packages/control/src/ensure-backend.ts';
import { readOwnerToken } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/packages/control/src/owner-token.ts';
const repository='/Users/eitrous/.codex/worktrees/6f13/ruukoto',root='/tmp/ruukoto-code-cold-stages';
const options=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
const rounds=Number(options.rounds??1),restarts=Number(options.restarts??2),modes=(options.modes??'none,light').split(','),tools=(options.tools??'coding,mock').split(','),tag=options.tag??'stages';
const results=[];
delete process.env.RUUKOTO_OWNER_TOKEN;delete process.env.RUUKOTO_OWNER_TOKEN_FILE;
let active:null|{events:object[];child:childProcess.ChildProcess|null;exited:Promise<void>|null}=null;
const record=(stage:string,extra:object={})=>active?.events.push({stage,wallMs:Date.now(),monoMs:+performance.now().toFixed(3),...extra});
const spawn=childProcess.spawn;
childProcess.spawn=function(...args){
 record('parent_spawn_begin');
 const child=spawn(...args);
 if(active){active.child=child;active.exited=new Promise(resolve=>child.once('exit',()=>{record('backend_exit',{code:child.exitCode,signal:child.signalCode});resolve();}));}
 record('parent_spawn_return',{pid:child.pid});return child;
};
syncBuiltinESMExports();
const connect=ControlClient.connect;
ControlClient.connect=async function(...args){record('socket_attempt_begin');try{const result=await connect.call(this,...args);record('socket_attempt_success');return result;}catch(error){record('socket_attempt_failed',{code:error.code});throw error;}};
const request=ControlClient.prototype.request;
ControlClient.prototype.request=async function(op,...args){record('request_begin',{op});try{const result=await request.call(this,op,...args);record('request_success',{op});return result;}catch(error){record('request_failed',{op,code:error.code});throw error;}};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
for(const mode of modes)for(const tool of tools)for(let round=1;round<=rounds;round++){
 const {dirs}=await makeTestDirs('cold-stages',0),server=new MockModelServer(()=>({kind:'text',text:'unused'}));
 await writeModelsJson(dirs,await server.start());
 const controlDir=path.join(dirs.root,'control'),socket=path.join(controlDir,'control.sock');
 try{
  for(let boot=0;boot<=restarts;boot++){
   const id=`${tag}-${mode}-${tool}-${round}-${boot}`,log=path.join(root,id+'-backend.json');
   const state={events:[],child:null,exited:null};active=state;
   let conn:ControlConnection|null=null;
   const started=performance.now();record('ensure_begin');
   try{
    const result=await ensureBackend({dataDir:dirs.dataDir,agentDir:dirs.agentDir,controlDir,spawnExecPath:process.execPath,spawnArgv:[path.join(repository,'apps/ruukoto-code/bin/ruukoto-code.mjs'),'server','--data-dir',dirs.dataDir,'--agent-dir',dirs.agentDir,...(tool==='mock'?['--tools','mock']:[])],env:{PATH:process.env.PATH,HOME:process.env.HOME,RUUKOTO_CODE_CONTROL_DIR:controlDir,...(mode==='light'?{NODE_OPTIONS:`--import=${root}/observer.mjs`,RUUKOTO_QA_COLD_LOG:log}:{})},deadlineMs:15000,exitGraceMs:300});
    record('ensure_return',{ok:result.ok});const ensured=performance.now();
    if(!result.ok||!result.spawned||!state.child)throw new Error('isolated startup failed or did not spawn');
    conn=new ControlConnection({socketPath:socket,token:readOwnerToken(controlDir)!,expectedProduct:'ruukoto-code'},{onState(s){record('formal_state',{state:s});},onSnapshot(){record('formal_snapshot');},onEvent(){}});
    record('formal_start');await conn.start();record('formal_online');const online=performance.now();
    await conn.request('stop',{});conn.close();conn=null;
    await Promise.race([state.exited,sleep(8000).then(()=>{throw new Error('QA backend exit timeout');})]);
    if(state.child.exitCode!==0)throw new Error('QA backend nonzero exit');
    const value={head:'c19d63e',id,mode,tool,round,boot,initialization:boot===0?'new-empty-data':'existing-empty-data',ensureMs:+(ensured-started).toFixed(3),formalMs:+(online-ensured).toFixed(3),totalMs:+(online-started).toFixed(3),backendPid:state.child.pid,backendExitCode:state.child.exitCode,parent:state.events,backend:mode==='light'?JSON.parse(fs.readFileSync(log,'utf8')):null};
    results.push(value);fs.writeFileSync(path.join(root,tag+'-results.json'),JSON.stringify(results,null,2)+'\n');
    process.stdout.write(JSON.stringify({id,ensureMs:value.ensureMs,formalMs:value.formalMs,totalMs:value.totalMs,exit:value.backendExitCode})+'\n');
   }finally{
    conn?.close();
    if(state.child&&state.child.exitCode===null&&state.child.signalCode===null){state.child.kill('SIGTERM');await Promise.race([state.exited,sleep(1500)]);if(state.child.exitCode===null&&state.child.signalCode===null){state.child.kill('SIGKILL');await state.exited;}}
    active=null;
   }
  }
 }finally{await server.close();await cleanupDirs(dirs);}
}
fs.writeFileSync(path.join(root,tag+'-cleanup.json'),JSON.stringify({complete:true,backendProcesses:results.map(r=>({pid:r.backendPid,exit:r.backendExitCode})),fixturesRemoved:true},null,2)+'\n');
