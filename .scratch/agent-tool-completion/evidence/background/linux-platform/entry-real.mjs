import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { launchLinuxExecution, stopLinuxExecution } from "./source/packages/agent/src/execution/native-linux-identity.ts";
const self=fileURLToPath(import.meta.url), mode=process.argv[2], root=process.argv[3];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),"utf8"));
const emit=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value)+"\n",{mode:0o600});
const waitFor=async(predicate,label)=>{const deadline=Date.now()+15000;while(!predicate()){if(Date.now()>deadline)throw new Error("Timeout: "+label);await delay(25);}};
const alive=pid=>{try {return fs.readFileSync(`/proc/${pid}/stat`,"utf8").split(") ")[1][0]!=="Z";}catch(error){if(error.code==="ENOENT")return false;throw error;}};
const launchChild=(args,options={})=>{const child=spawn(process.execPath,[self,...args],{stdio:["ignore","pipe","pipe"],...options});let stderr="";child.stderr?.on("data",data=>stderr+=data);child.stdout?.resume();child.done=new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal,stderr})));return child;};
if(mode==="owner"){
  const input=read("input.json"), unit=await launchLinuxExecution(path.join(root,"claims"),input.ref,input.prepared,input.spec);
  unit.stdout.resume();unit.stderr.resume();unit.stdout.once("end",()=>emit("stdout-eof.json",{}));unit.stderr.once("end",()=>emit("stderr-eof.json",{}));
  void unit.exit.then(value=>emit("launcher-exit.json",value));emit("ready.json",{scope:unit.entry.id,owner:process.pid});setInterval(()=>{},1000);
}else if(mode==="stop"){
  const input=read("input.json");emit("stop.json",await stopLinuxExecution(path.join(root,"claims"),input.ref));
}else if(mode==="run"){
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"ruukoto-bg-linux-")));fs.chmodSync(base,0o700);
  const results=[];let failed;
  for(const scenario of ["normal","leader-exit-inherited-pipe","owner-SIGKILL","leader-SIGKILL","escaped-scope"]){
    const dir=path.join(base,scenario);fs.mkdirSync(dir,{mode:0o700});
    const claims=path.join(dir,"claims"),workspace=path.join(dir,"work"),tempDir=path.join(dir,"temp");for(const target of [claims,workspace,tempDir])fs.mkdirSync(target,{mode:0o700});
    const ref={executionId:`native_${randomBytes(12).toString("hex")}`,machineId:fs.readFileSync("/etc/machine-id","utf8").trim()};
    const workerPath=path.join(dir,"worker.mjs"), heart=path.join(workspace,"heart"),childInfo=path.join(workspace,"child.json"),leader=path.join(workspace,"leader.json"),exitFlag=path.join(workspace,"exit");
    const escapeScope=`ruukoto-proof-${randomBytes(12).toString("hex")}.scope`;
    const python=`import os,time,json,signal\nos.setsid()\nopen(${JSON.stringify(childInfo)},'w').write(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp()}))\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nf=open(${JSON.stringify(heart)},'a',buffering=1)\nwhile True:\n f.write('tick\\n');time.sleep(.02)\n`;
    fs.writeFileSync(workerPath,`import fs from 'node:fs';import{spawn}from'node:child_process';fs.writeFileSync(${JSON.stringify(leader)},JSON.stringify({pid:process.pid}));const python=${JSON.stringify(python)};spawn(${JSON.stringify(scenario==="escaped-scope"?"/usr/bin/systemd-run":"/usr/bin/python3")},${JSON.stringify(scenario==="escaped-scope"?["--user","--scope","--quiet","--unit",escapeScope,"/usr/bin/python3","-I","-c",python]:["-I","-c",python])},{stdio:['ignore',1,2]});setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitFlag)}))process.exit(0)},20);`);
    const prepared={workspace,tempDir,env:{},mounts:[],runtimeReadRoots:[],toolAliases:[],nodePath:process.execPath,workerPath};
    const spec={taskId:"bg-linux-proof",mode:"full_access",workspace,grantedPaths:[]};fs.writeFileSync(path.join(dir,"input.json"),JSON.stringify({ref,prepared,spec}));
    const owner=launchChild(["owner",dir]);let stopped=false, escapedChild;
    try{
      await waitFor(()=>fs.existsSync(path.join(dir,"ready.json"))||owner.exitCode!==null,"ready");if(!fs.existsSync(path.join(dir,"ready.json")))throw new Error((await owner.done).stderr);
      await waitFor(()=>fs.existsSync(heart)&&fs.statSync(heart).size>=20,"heartbeat");
      const ready=JSON.parse(fs.readFileSync(path.join(dir,"ready.json"))), observation=JSON.parse(fs.readFileSync(path.join(claims,ref.executionId,"observation.json"))),claim=JSON.parse(fs.readFileSync(path.join(claims,ref.executionId,"claim.json"))),launcher=JSON.parse(fs.readFileSync(path.join(claims,ref.executionId,"launcher.json"))),desc=JSON.parse(fs.readFileSync(childInfo));
      const descendantCgroup=fs.readFileSync(`/proc/${desc.pid}/cgroup`,"utf8").trim();let launcherExitedBeforeStop=false;
      if(scenario==="owner-SIGKILL"){owner.kill("SIGKILL");await owner.done;}
      if(scenario==="leader-SIGKILL"){assert.equal(JSON.parse(fs.readFileSync(leader)).pid,launcher.pid);process.kill(launcher.pid,"SIGKILL");await waitFor(()=>fs.existsSync(path.join(dir,"launcher-exit.json")),"leader exit");launcherExitedBeforeStop=true;}
      if(scenario==="leader-exit-inherited-pipe"){fs.writeFileSync(exitFlag,"");await waitFor(()=>fs.existsSync(path.join(dir,"launcher-exit.json")),"leader exit");launcherExitedBeforeStop=true;assert.equal(fs.existsSync(path.join(dir,"stdout-eof.json")),false,"inherited pipe must remain open");assert.equal(alive(desc.pid),true);}
      const stopper=launchChild(["stop",dir]);const stopExit=await stopper.done;assert.equal(stopExit.code,0,stopExit.stderr);const stopResult=JSON.parse(fs.readFileSync(path.join(dir,"stop.json")));stopped=stopResult.exited;
      const size=fs.statSync(heart).size;await delay(200);const heartbeatContinues=fs.statSync(heart).size>size,descendantAlive=alive(desc.pid);
      if(scenario==="escaped-scope")escapedChild=desc;
      else{assert.equal(stopped,true);assert.equal(heartbeatContinues,false);assert.equal(descendantAlive,false);if(scenario!=="owner-SIGKILL")await waitFor(()=>fs.existsSync(path.join(dir,"stdout-eof.json")),"stdout EOF");}
      const repeated=await stopLinuxExecution(claims,ref);let duplicateRejected=false;try{await launchLinuxExecution(claims,ref,prepared,spec);}catch(error){duplicateRejected=error.code==="execution_claim_failed";}assert.equal(duplicateRejected,true);
      results.push({scenario,ref,scope:ready.scope,bootId:claim.bootId,token:claim.token,observation,launcher,desc,descendantCgroup,launcherExitedBeforeStop,stopExit,stopResult,repeat:repeated.exited,duplicateRejected,heartbeatContinues,descendantAlive,stdoutEof:fs.existsSync(path.join(dir,"stdout-eof.json"))});
    }catch(error){failed=String(error.stack??error);results.push({scenario,error:failed});}
    finally{
      owner.kill("SIGKILL");await owner.done;
      if(escapedChild&&alive(escapedChild.pid)){
        const state=execFileSync('/usr/bin/systemctl',['--user','show',escapeScope,'--property','ControlGroup,InvocationID,Description'],{encoding:'utf8'});const group=state.split('\n').find(line=>line.startsWith('ControlGroup=')).slice(13);assert.ok(group.endsWith('/'+escapeScope));assert.ok(fs.readFileSync(`/proc/${escapedChild.pid}/cgroup`,'utf8').includes('0::'+group));const fd=fs.openSync('/sys/fs/cgroup'+group,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{const killFd=fs.openSync(`/proc/self/fd/${fd}/cgroup.kill`,fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW);try{fs.writeSync(killFd,'1');}finally{fs.closeSync(killFd);}}finally{fs.closeSync(fd);}await waitFor(()=>!alive(escapedChild.pid),'escaped child cleanup');
      }
      try{assert.equal((await stopLinuxExecution(claims,ref)).exited,true);}catch(error){results.push({scenario,cleanupError:String(error)});failed??=String(error);}
    }
    if(failed)break;
  }
  const result={base,node:process.version,platform:process.platform,source:"actual production modules bundled with esbuild",results,failed:failed??null};fs.writeFileSync(path.join(base,"result.json"),JSON.stringify(result,null,2)+"\n");process.stdout.write(JSON.stringify(result,null,2)+"\n");if(failed)process.exitCode=1;
}
