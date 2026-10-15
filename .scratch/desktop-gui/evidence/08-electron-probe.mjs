import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const root = process.cwd(), require = createRequire(path.join(root,'package.json'));
const dir = fs.mkdtempSync('/tmp/r08-gui-'), userData = path.join(dir,'app'), controlDir = path.join(dir,'code'), log = path.join(dir,'children');
const token = 'r08-fixture-secret-'.repeat(3);
fs.mkdirSync(userData); fs.mkdirSync(controlDir); fs.mkdirSync(path.join(dir,'bin'));
fs.writeFileSync(path.join(controlDir,'owner.token'),token);
fs.writeFileSync(path.join(userData,'personal.json'),JSON.stringify({host:'fixture',controlDir:'/var/lib/ruukoto/control'}));
fs.writeFileSync(path.join(dir,'scenario'),'{}');
const sockets = new Set();
const servers = [];
const snapshot = product => ({product,projects:[],sessions:[],tasks:[],confirmations:[],artifacts:[],previews:{},instanceId:product,execution:{backend:'local',note:'fixture'},defaultModel:{provider:'mock',id:'mock',name:'Mock',thinkingLevel:'off'}});
for (const product of ['ruukoto-code','ruukoto']) {
 const server = net.createServer(socket=>{
  sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{});
  let buffer=''; socket.on('data',data=>{
   buffer+=data; while(buffer.includes('\n')) {
    const i=buffer.indexOf('\n'), req=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
    const result=req.op==='auth'?{authenticated:true}:req.op==='connect'?{seq:0,replay:[],snapshot:snapshot(product)}:{sessions:[],total:0,nextOffset:null};
    socket.write(JSON.stringify({v:26,id:req.id,ok:true,result})+'\n');
   }
  });
 });
 server.listen(product==='ruukoto-code'?path.join(controlDir,'control.sock'):path.join(dir,'remote.sock'));
 await once(server,'listening'); servers.push(server);
}
fs.writeFileSync(path.join(dir,'bin','ssh'),`#!${process.execPath}
const fs=require('node:fs'),net=require('node:net');
const args=process.argv.slice(2),read=!args.includes('-N');
fs.appendFileSync(process.env.R08_LOG,JSON.stringify({pid:process.pid,read})+'\\n');
if(read){
 const state=JSON.parse(fs.readFileSync(process.env.R08_SCENARIO));
 if(state.hang){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
 else process.stdout.write(${JSON.stringify(token)});
}else{
 const local=args[args.indexOf('-L')+1].split(':')[0];fs.rmSync(local,{force:true});
 net.createServer(client=>{const remote=net.connect(process.env.R08_REMOTE);client.pipe(remote);remote.pipe(client);client.on('error',()=>remote.destroy());remote.on('error',()=>client.destroy());client.on('close',()=>remote.destroy());remote.on('close',()=>client.destroy());}).listen(local);
}
`,{mode:0o755});
fs.writeFileSync(path.join(dir,'bootstrap.cjs'),`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(userData)});
const evidence=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));
const children=()=>fs.existsSync(${JSON.stringify(log)})?fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').map(JSON.parse):[];
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await sleep(50);}throw Error('probe timeout');}
app.on('browser-window-created',(_e,win)=>{
 win.hide();
 win.webContents.once('did-finish-load',()=>void (async()=>{
  const js=s=>win.webContents.executeJavaScript(s);
  await js('globalThis.r08=[];globalThis.ruukoto.subscribe("personal",u=>r08.push(u));globalThis.ruukoto.subscribe("code",u=>r08.push({...u,target:"code"}));void 0;');
  await until(()=>js('r08.some(u=>u.type==="snapshot"&&u.result.snapshot.product==="ruukoto")&&r08.some(u=>u.type==="snapshot"&&u.result.snapshot.product==="ruukoto-code")'));
  evidence.push('real Electron: both target snapshots through sandbox preload');
  assert.equal(await js('typeof require'), 'undefined');
  assert.equal(await js('JSON.stringify(r08).includes("r08-fixture-secret")'),false);
  const cfg=await js('ruukoto.request("personal","desktop_personal_config_read",{})');assert.equal(cfg.ok,true);assert.deepEqual(Object.keys(cfg.value).sort(),['controlDir','host']);
  assert.equal((await js('ruukoto.request("personal","desktop_personal_config_save",{host:"-oBad"})')).ok,false);
  evidence.push('config validation and token-free IPC');
  const old=children().filter(c=>!c.read).at(-1).pid;process.kill(old,'SIGTERM');
  await until(()=>js('r08.filter(u=>u.type==="snapshot"&&u.result.snapshot.product==="ruukoto").length>=2'));
  evidence.push('forward killed: fresh authenticated snapshot');
  fs.writeFileSync(${JSON.stringify(path.join(dir,'scenario'))},JSON.stringify({hang:true}));
  await js('void ruukoto.request("personal","desktop_personal_config_save",{host:"replacement",controlDir:"/var/lib/ruukoto/control"});');
  await until(()=>children().some(c=>c.read&&alive(c.pid)));
  evidence.push('config replacement began a blocking reader');
  globalThis.r08Quitting=true;
  app.quit();setTimeout(()=>app.quit(),100);
 })().catch(error=>{fs.writeFileSync(${JSON.stringify(path.join(dir,'error'))},String(error.stack));app.exit(1);}));
});
app.on('will-quit',()=>{
 if(!globalThis.r08Quitting)return;
 try {assert.ok(children().every(c=>!alive(c.pid)));assert.equal(fs.existsSync(${JSON.stringify(path.join(userData,'ssh/personal.sock'))}),false);evidence.push('repeated quit waited for SIGKILL; no child or socket remains');fs.writeFileSync(${JSON.stringify(path.join(dir,'evidence'))},JSON.stringify(evidence));}
 catch(e){fs.writeFileSync(${JSON.stringify(path.join(dir,'error'))},String(e.stack));process.exitCode=1;}
});
import(${JSON.stringify('file://'+path.join(root,'apps/desktop/out/main/index.js'))});
`);
const child=spawn(require('electron'),[path.join(dir,'bootstrap.cjs')],{env:{...process.env,PATH:path.join(dir,'bin')+':'+process.env.PATH,RUUKOTO_DESKTOP_MANAGED:'1',RUUKOTO_CODE_CONTROL_DIR:controlDir,RUUKOTO_CODE_DATA_DIR:path.join(dir,'data'),RUUKOTO_CODE_AGENT_DIR:path.join(dir,'agent'),R08_LOG:log,R08_SCENARIO:path.join(dir,'scenario'),R08_REMOTE:path.join(dir,'remote.sock')},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',d=>stderr+=d);child.stdout.resume();
const timeout=setTimeout(()=>child.kill('SIGTERM'),40000);
try{
 const [code]=await once(child,'close'); clearTimeout(timeout);
 if(fs.existsSync(path.join(dir,'error')))throw Error(fs.readFileSync(path.join(dir,'error'),'utf8'));
 if(!fs.existsSync(path.join(dir,'evidence')))throw Error('no evidence; exit '+code+' '+stderr);
 const evidence=JSON.parse(fs.readFileSync(path.join(dir,'evidence'),'utf8'));
 const containsToken = folder => fs.readdirSync(folder,{withFileTypes:true}).some(entry => entry.isDirectory() ? containsToken(path.join(folder,entry.name)) : entry.isFile() && fs.readFileSync(path.join(folder,entry.name)).includes(Buffer.from(token)));
 if(containsToken(userData))throw Error('token persisted in app profile');
 evidence.push('entire app profile contains no token bytes');
 if(code!==0)throw Error('exit '+code);
 process.stdout.write(JSON.stringify({passed:evidence,profile:'temporary',remote:'local socket fixture',tokenOnDiskInApp:false},null,2)+'\n');
}finally{
 clearTimeout(timeout);if(child.exitCode===null)child.kill('SIGKILL');
 if(fs.existsSync(log))for(const line of fs.readFileSync(log,'utf8').trim().split('\n')){const {pid}=JSON.parse(line);try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
 for(const socket of sockets)socket.destroy();for(const server of servers)await new Promise(r=>server.close(r));
 fs.rmSync(dir,{recursive:true,force:true});
}
