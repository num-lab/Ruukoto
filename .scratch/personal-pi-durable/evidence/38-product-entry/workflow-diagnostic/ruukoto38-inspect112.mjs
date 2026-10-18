import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const pid=49528, output='/tmp/ruukoto38-112-cpu-profile.json', summary='/tmp/ruukoto38-112-inspector-summary.json';
const command=execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim();
if(!command.includes('test/112-workflow-real-steps.test.ts')) throw new Error('Target PID no longer owns test112');
try { await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(500)}); throw new Error('Inspector listener already exists; refusing to modify it'); }
catch(error) { if(error.message==='Inspector listener already exists; refusing to modify it') throw error; }
process.kill(pid,'SIGUSR1');
let endpoints;
for(let i=0;i<50;i++){try{endpoints=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(500)})).json();break;}catch{await delay(100);}}
if(!endpoints) throw new Error('Inspector activation did not expose endpoint');
const target=endpoints.find(value=>String(value.url).includes('test/112-workflow-real-steps.test.ts'));
if(!target) throw new Error('Inspector target does not match owned test112');
const ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
let next=0;const pending=new Map();
ws.addEventListener('message',event=>{const result=JSON.parse(event.data);if(result.id){const item=pending.get(result.id);if(item){pending.delete(result.id);clearTimeout(item.timer);result.error?item.reject(new Error(JSON.stringify(result.error))):item.resolve(result.result);}}});
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Inspector request timeout '+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
let profile, failure;
try {await send('Profiler.enable');await send('Profiler.start');await delay(1000);({profile}=await send('Profiler.stop'));fs.writeFileSync(output,JSON.stringify(profile));}
catch(error){failure=String(error);}
finally { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({id:++next,method:'Runtime.evaluate',params:{expression:"process.getBuiltinModule('node:inspector').close()",returnByValue:true}})); await delay(300);ws.close(); }
let listenerClosed=false;
for(let i=0;i<30;i++){try{await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(300)});}catch{listenerClosed=true;break;}await delay(100);}
fs.writeFileSync(summary,JSON.stringify({pid,command,profile:profile?output:null,failure,listenerClosed,sampleCount:profile?.samples?.length},null,2)+'\n');
process.stdout.write(fs.readFileSync(summary));
if(failure||!listenerClosed) process.exitCode=1;
