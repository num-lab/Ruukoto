import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const pid=49528;
let listeners='';try{listeners=execFileSync('lsof',['-nP','-iTCP:9229','-sTCP:LISTEN','-Fpn'],{encoding:'utf8'});}catch{}
if(!listeners.split('\n').includes('p'+pid))throw new Error('Listener is not the owned test112 PID');
const targets=await(await fetch('http://127.0.0.1:9229/json/list')).json();const target=targets.find(x=>String(x.url).includes('test/112-workflow-real-steps.test.ts'));if(!target)throw new Error('Target mismatch');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
const responses=[];ws.addEventListener('message',event=>{const x=JSON.parse(event.data);if(x.id)responses.push(x);});
ws.send(JSON.stringify({id:1,method:'Runtime.enable'}));await delay(100);
ws.send(JSON.stringify({id:2,method:'Runtime.evaluate',params:{expression:"process.getBuiltinModule('node:inspector').close()",returnByValue:true}}));
await delay(2000);ws.close();await delay(1000);
let remaining='';try{remaining=execFileSync('lsof',['-nP','-iTCP:9229','-sTCP:LISTEN','-Fpn'],{encoding:'utf8'});}catch{}
const result={pid,responses,remainingListener:remaining,closed:!remaining.split('\n').includes('p'+pid)};fs.writeFileSync('/tmp/ruukoto38-112-inspector-close.json',JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify(result)+'\n');if(!result.closed)process.exitCode=1;
