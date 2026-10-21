import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import * as readline from 'node:readline';
import {product} from '/Users/eitrous/mirasim-worktrees/ruukoto/lucky-sailing-sparrow/apps/ruukoto-code/src/product.ts';
import {afterTool,realTools,startTestRuntime,waitFor} from '/Users/eitrous/mirasim-worktrees/ruukoto/lucky-sailing-sparrow/test/helpers/testkit.ts';

const repo='/Users/eitrous/mirasim-worktrees/ruukoto/lucky-sailing-sparrow';
const evidence=process.env.RK_CLIENT_PROOF_DIR??'/tmp/ruukoto-bg-real-clients-20261021/attempt2';
fs.mkdirSync(evidence,{recursive:true});
const require=createRequire(path.join(repo,'package.json'));
const controlDir=fs.mkdtempSync('/tmp/rk-bg-client-');
let command='';
const t=await startTestRuntime('background-real-clients',req=>afterTool(req)?{kind:'text',text:'已启动真实后台'}:{kind:'tool_calls',calls:[{id:`start_${crypto.randomUUID()}`,name:'process_start',arguments:{command}}]},{workDirs:1,config:{...realTools(),product:product.runtime,controlDir,socketPath:undefined}});
const rt=t.runtime;
const session=(await rt.openWorkspace({cwd:t.work[0],mode:'full_access',modelSelection:rt.defaultSelection})).session;
const calls:any[]=[];
for(const name of ['stopBackgroundProcess','endSessionBackground','backgroundProcessOutput'] as const){
 const original=(rt[name] as Function).bind(rt);
 (rt as any)[name]=(...args:any[])=>{const entry={name,args,at:new Date().toISOString()};calls.push(entry);fs.writeFileSync(path.join(evidence,'control-calls.json'),JSON.stringify(calls,null,2)+'\n');return original(...args);};
}
const fixture=path.join(t.work[0],'service.cjs');
fs.writeFileSync(fixture,`const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');const label=process.argv[2],base=process.argv[3],out='STDOUT_'+crypto.randomBytes(8).toString('hex'),err='STDERR_'+crypto.randomBytes(8).toString('hex');const server=http.createServer((req,res)=>res.end('REAL_BACKGROUND_'+label));server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port;fs.writeFileSync(base+'.json',JSON.stringify({url,out,err,pid:process.pid}));process.stdout.write(out+' '+url+'\\n');process.stderr.write(err+'\\n');});`);
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const probes:any[]=[];
async function start(label:string){
 const base=path.join(t.work[0],label);command=[process.execPath,fixture,label,base].map(quote).join(' ');
 const task=await rt.submit({sessionId:session.id,requestId:'start_'+label,input:'启动后台 '+label,modelSelection:rt.defaultSelection});
 await waitFor('后台工具轮完成',()=>['completed','failed','interrupted'].includes(rt.store.getTask(task.id)!.status),30000);
 assert.equal(rt.store.getTask(task.id)!.status,'completed',JSON.stringify(rt.store.listToolOpsByTask(task.id)));
 await waitFor('服务endpoint已落盘',()=>fs.existsSync(base+'.json'));
 const ready=JSON.parse(fs.readFileSync(base+'.json','utf8'));
 const proc=rt.listBackgroundProcesses(session.id).processes[0];
 await waitFor('双流已捕获',()=>{const p=rt.listBackgroundProcesses(session.id).processes.find(p=>p.id===proc.id)!;return p.stdoutBytes>0&&p.stderrBytes>0;});
 assert.equal(await(await fetch(ready.url)).text(),'REAL_BACKGROUND_'+label);
 assert.equal(rt.store.getOccupancyByDir(session.cwdReal)?.processId,proc.id);
 const probe={label,taskId:task.id,processId:proc.id,...ready};probes.push(probe);save('processes',probes);return probe;
}
function save(name:string,data:any){fs.writeFileSync(path.join(evidence,name+'.json'),JSON.stringify(data,null,2)+'\n');}
function state(){return {processes:rt.listBackgroundProcesses(session.id),occupancy:rt.store.listAllOccupancy(),closures:rt.store.db.prepare('SELECT * FROM background_process_closures').all()};}
async function stopped(probe:any){await waitFor('停止已经核实',()=>rt.listBackgroundProcesses(session.id).processes.find(p=>p.id===probe.processId)?.stopVerified===true,20000);await assert.rejects(fetch(probe.url));assert.equal(rt.store.listAllOccupancy().length,0);}
const driver=fs.readFileSync(path.join(repo,'test/15-tui-pty.test.ts'),'utf8').split('const PTY_DRIVER = `')[1].split('`;\n')[0];
async function pty(name:string,inputs:Array<[number,string]>,expect:string[]){
 const payload={cmd:[process.execPath,path.join(repo,'node_modules/tsx/dist/cli.mjs'),path.join(repo,'apps/ruukoto-code/src/main.ts'),'tui','--session',session.id],env:{RUUKOTO_CODE_DATA_DIR:t.dirs.dataDir,RUUKOTO_CODE_AGENT_DIR:t.dirs.agentDir,RUUKOTO_CODE_CONTROL_DIR:controlDir,RUUKOTO_CODE_PENDING_DIR:path.join(t.dirs.root,'pending'),RUUKOTO_OWNER_TOKEN:'',RUUKOTO_OWNER_TOKEN_FILE:''},inputs,expect,size:{columns:110,rows:32},timeout:26};
 save(name+'-input',payload);
 const result:any=await new Promise((resolve,reject)=>{const child=spawn('python3',['-c',driver,JSON.stringify(payload)],{cwd:repo});let out='',err='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);child.on('error',reject);child.on('close',()=>{try{resolve(JSON.parse(out.trim()));}catch(error){reject(new Error('PTY结果解析失败 '+err+' '+out));}});});
 save(name,result);fs.writeFileSync(path.join(evidence,name+'.ansi'),result.all);assert.equal(result.exitCode,0,result.tail);assert.equal(result.cleanupError,null,result.tail);assert.equal(result.expectSeen,result.expectTotal,result.tail);assert.ok(result.all.includes('\x1b[?1049l'));return result;
}
const manifest={repository:repo,root:t.dirs.root,dataDir:t.dirs.dataDir,agentDir:t.dirs.agentDir,controlDir,sessionId:session.id,model:'mock HTTP provider',at:new Date().toISOString()};save('manifest',manifest);
save('source-sha256',Object.fromEntries(['packages/tui/src/tui/background-processes.ts','packages/runtime/src/runtime.ts','packages/runtime/src/background-processes.ts','packages/control/src/background-end.ts','worker/worker.mjs','worker/background-worker.mjs','worker/native-macos-supervisor'].map(f=>[f,createHash('sha256').update(fs.readFileSync(path.join(repo,f))).digest('hex')])));
process.stdout.write(JSON.stringify({ready:manifest})+'\n');
try{
 if(!process.env.RK_SKIP_TUI){
 const a=await start('tui_single');
 const single=await pty('tui-single',[[3,'/processes\r'],[4,'\r'],[5,'\r'],[6,'\x1b'],[6.5,'\x1b[B'],[7,'\r'],[8,'\x1b'],[8.5,'\x1b[B'],[9,'\x1b[B'],[9.5,'\r'],[12,'\x1b'],[12.5,'\x1b'],[13,'/quit\r']],['本会话后台',a.out,a.err,'已退出 TUI']);
 assert.ok(!single.all.includes('请选择会话并等待连接恢复，再查询后台。'));assert.ok(!single.segments[11].includes('正在登记停止'));
 await stopped(a);assert.ok(calls.some(c=>c.name==='stopBackgroundProcess'&&c.args[0].processId===a.processId));save('tui-single-state',state());
 const b=await start('tui_preserved');
 await pty('tui-close',[[3,'/processes\r'],[5,'\x1b'],[6,'/quit\r']],['本会话后台','已退出 TUI']);
 assert.equal(await(await fetch(b.url)).text(),'REAL_BACKGROUND_'+b.label);assert.equal(rt.listBackgroundProcesses(session.id).processes.find(p=>p.id===b.processId)?.state,'running');assert.equal(rt.store.getOccupancyByDir(session.cwdReal)?.processId,b.processId);save('tui-close-state',state());
 const end=await pty('tui-end',[[3,'/processes\r'],[4,'\x1b[B'],[4.2,'\x1b[B'],[4.4,'\x1b[B'],[5,'\r'],[6,'\r'],[10,'\x1b'],[11,'/quit\r']],['本会话后台','确认结束本会话后台','本次结束请求涉及的后台已核实停止。','已退出 TUI']);assert.ok(!end.all.includes('请选择会话并等待连接恢复，再查询后台。'));
 await stopped(b);assert.ok(calls.some(c=>c.name==='endSessionBackground'));save('tui-end-state',state());
 process.stdout.write('TUI_PASSED_WAITING_ELECTRON\n');
 }
 if(process.env.RK_SKIP_TUI)await electron();
 else {
 for await(const line of readline.createInterface({input:process.stdin})){
  if(line.trim()==='electron'){await electron();break;}
  if(line.trim()==='end')break;
 }
 }
 save('final-state',state());
 fs.cpSync(t.dirs.root,path.join(evidence,'runtime-profile'),{recursive:true,filter:s=>!s.endsWith('.sock')});
 process.stdout.write('ALL_PASSED\n');
}catch(error){save('failure',{message:String(error),stack:(error as Error).stack,state:state()});throw error;}
finally{for(const p of rt.listBackgroundProcesses(session.id).processes){if(!p.stopVerified)await rt.stopBackgroundProcess({sessionId:session.id,processId:p.id});}await waitFor('仅本次后台停止',()=>rt.listBackgroundProcesses(session.id).processes.every(p=>p.stopVerified),20000).catch(e=>save('cleanup-error',{message:String(e),state:state()}));save('cleanup',state());await t.shutdown();}

async function electron(){
 const desktop=path.join(evidence,'desktop');fs.mkdirSync(desktop,{recursive:true});fs.cpSync(path.join(repo,'apps/desktop/out'),path.join(desktop,'out'),{recursive:true});fs.writeFileSync(path.join(desktop,'package.json'),JSON.stringify({type:'module'})+'\n');
 const main=path.join(desktop,'out/main/index.js'),original=fs.readFileSync(main,'utf8');assert.equal(original.split('new BrowserWindow({').length,2);fs.writeFileSync(main,original.replace('new BrowserWindow({','new BrowserWindow({ show: false,'));
 save('artifact-sha256',Object.fromEntries(['worker/worker.mjs','worker/native-macos-supervisor','apps/desktop/out/main/index.js',...fs.readdirSync(path.join(repo,'apps/desktop/out/renderer/assets')).filter(n=>n.endsWith('.js')).map(n=>'apps/desktop/out/renderer/assets/'+n)].filter(f=>fs.existsSync(path.join(repo,f))).map(f=>[f,createHash('sha256').update(fs.readFileSync(path.join(repo,f))).digest('hex')])));
 const c=await start('electron_single');
 const one=await launchElectron(1,desktop);await openPanel(one);
 await one.clickText('查看日志');await one.contains(c.out);await one.screenshot('electron-stdout');await one.clickText('stderr');await one.contains(c.err);await one.screenshot('electron-stderr');
 await one.clickText('请求停止');await stopped(c);await one.contains('已核实停止');await one.screenshot('electron-single-stopped');save('electron-single-state',state());await one.close();
 const d=await start('electron_preserved');
 const two=await launchElectron(2,desktop);await openPanel(two);await two.contains('运行中');await two.screenshot('electron-running');await two.close();
 assert.equal(await(await fetch(d.url)).text(),'REAL_BACKGROUND_'+d.label);assert.equal(rt.store.getOccupancyByDir(session.cwdReal)?.processId,d.processId);save('electron-close-state',state());
 const three=await launchElectron(3,desktop);await openPanel(three);await three.clickText('结束本会话后台');await three.contains('确认结束本会话后台');await three.screenshot('electron-end-confirm');await three.clickText('确认结束本会话后台');await stopped(d);await three.contains('已核实停止');await three.screenshot('electron-end-stopped');save('electron-end-state',state());await three.close();
}
async function launchElectron(index:number,desktop:string){
 const userData=path.join(evidence,'electron-profile-'+index),quit=path.join(evidence,'electron-quit-'+index);fs.mkdirSync(userData,{recursive:true});
 const bootstrap=path.join(evidence,'electron-'+index+'.cjs');fs.writeFileSync(bootstrap,`const {app}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(userData)});app.commandLine.appendSwitch('remote-debugging-port','0');app.setActivationPolicy('prohibited');setInterval(()=>{if(fs.existsSync(${JSON.stringify(quit)}))app.quit();},200);import(${JSON.stringify(path.join(desktop,'out/main/index.js'))});`);
 const child=spawn(require('electron'),[bootstrap],{cwd:desktop,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,RUUKOTO_DESKTOP_MANAGED:'1',RUUKOTO_CODE_DATA_DIR:t.dirs.dataDir,RUUKOTO_CODE_AGENT_DIR:t.dirs.agentDir,RUUKOTO_CODE_CONTROL_DIR:controlDir}});let stderr='',stdout='';child.stderr.on('data',b=>{stderr+=b;fs.writeFileSync(path.join(evidence,'electron-'+index+'.stderr'),stderr);});child.stdout.on('data',b=>{stdout+=b;fs.writeFileSync(path.join(evidence,'electron-'+index+'.stdout'),stdout);});
 await waitFor('Electron CDP',()=>/DevTools listening on ws:\/\/.*:(\d+)\//.test(stderr),20000);
 const port=stderr.match(/DevTools listening on ws:\/\/.*:(\d+)\//)![1];let page:any;await waitFor('Electron renderer',async()=>{page=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find((p:any)=>p.type==='page'&&p.url.startsWith('file:'));return !!page;},20000);
 const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=reject;});let id=0;const waiting=new Map<number,{resolve:Function,reject:Function}>();ws.onmessage=e=>{const data=JSON.parse(String(e.data));if(data.id){const w=waiting.get(data.id);waiting.delete(data.id);if(data.error)w?.reject(data.error);else w?.resolve(data.result);}};
 const send=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const n=++id;waiting.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});await send('Runtime.enable');await send('Page.enable');
 const evaluate=async(expression:string)=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const contains=async(text:string)=>waitFor('UI出现 '+text,async()=>await evaluate('document.body.innerText.includes('+JSON.stringify(text)+')'),15000);
 const clickElement=async(expression:string)=>{let box:any;await waitFor('可见点击目标',async()=>{box=await evaluate(`(()=>{const e=${expression};if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);return !!box;},15000);await send('Input.dispatchMouseEvent',{type:'mouseMoved',...box});await send('Input.dispatchMouseEvent',{type:'mousePressed',...box,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',...box,button:'left',clickCount:1});};
 const clickText=async(text:string)=>clickElement(`[...(document.querySelector('[role="dialog"]')??document).querySelectorAll('button,[role="menuitem"],[role="tab"]')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled&&e.getClientRects().length)`);
 const screenshot=async(name:string)=>{fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));fs.writeFileSync(path.join(evidence,name+'.txt'),await evaluate('document.body.innerText'));};
 const close=async()=>{fs.writeFileSync(quit,'quit\n');await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Electron退出超时'));},10000);child.once('close',code=>{clearTimeout(timer);ws.close();assert.equal(code,0);resolve();});});};
 return {evaluate,send,contains,clickText,clickElement,screenshot,close,index};
}
async function openPanel(client:any){
 await waitFor('真实会话列表',async()=>client.evaluate(`document.querySelectorAll('button[aria-label^="会话菜单 "]').length>0`),20000);
 await client.screenshot('electron-'+client.index+'-initial');
 await client.clickElement(`document.querySelector('button.workspace-session')`);
 await new Promise(resolve=>setTimeout(resolve,300));
 await client.clickElement(`document.querySelector('button[aria-label^="会话菜单 "]')`);
 await client.screenshot('electron-'+client.index+'-menu');
 await client.clickText('后台进程与日志');await client.contains('本会话后台');
 await waitFor('后台对话框可见',async()=>client.evaluate(`!!document.querySelector('[role="dialog"]')`));
 await new Promise(resolve=>setTimeout(resolve,300));
}
