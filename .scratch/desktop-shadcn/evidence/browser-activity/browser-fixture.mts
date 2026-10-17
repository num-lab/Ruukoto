import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/node_modules/vite/dist/node/index.js';
import react from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/node_modules/@vitejs/plugin-react/dist/index.js';
import tailwindcss from '@tailwindcss/vite';
import { BrowserDocuments } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/apps/desktop/src/main/browser-documents.ts';
const project='/Users/eitrous/.codex/worktrees/6f13/ruukoto';
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'ruukoto-browser-native-'));
await fs.mkdir(path.join(temporary,'assets'));
await fs.writeFile(path.join(temporary,'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="assets/style.css"></head><body><h1>本机 HTML</h1><img id="image" src="assets/pixel.svg"><script type="module" src="assets/main.js"></script></body></html>');
await fs.writeFile(path.join(temporary,'assets/style.css'), 'h1{color:rgb(12,34,56)}');
await fs.writeFile(path.join(temporary,'assets/pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
await fs.writeFile(path.join(temporary,'assets/main.js'), 'import { value } from "./part.js"; const data=await fetch("data.json",{credentials:"omit"}).then(r=>r.json()); document.body.dataset.result=value+":"+data.ok; document.body.dataset.bridge=String(typeof window.ruukoto); await document.getElementById("image").decode(); parent.postMessage({type:"fixture-result",result:document.body.dataset.result,bridge:document.body.dataset.bridge,color:getComputedStyle(document.querySelector("h1")).color,image:document.getElementById("image").naturalWidth},"*");');
await fs.writeFile(path.join(temporary,'assets/part.js'), 'export const value="module";');
await fs.writeFile(path.join(temporary,'data.json'), '{"ok":true}');
const fileURL=pathToFileURL(path.join(temporary,'index.html')).href;
const documents=new BrowserDocuments([]);
const entry=path.join(project,'apps/desktop/src/renderer/__local_browser_fixture.tsx');
let origin='';
const server=await createServer({ configFile:false, root:path.join(project,'apps/desktop/src/renderer'), html:{cspNonce:"fixture_nonce_1234567890abcd"},plugins:[react(),tailwindcss(),{
 name:'local-browser-fixture',
 resolveId(id){if(id==='/__local_browser_fixture.tsx'||id===entry)return entry;},
 load(id){if(id===entry)return `import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';import{BrowserPanel}from'/inspector-panels.tsx';import{browserNavigation}from'/browser-navigation.ts';import'/style.css';const native=!!window.ruukoto;window.ruukoto??={request:async(target,op,params)=>fetch('/__fixture_rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,params})}).then(r=>r.json())};function Fixture(){const[proof,setProof]=useState(null);useEffect(()=>{const listener=event=>{if(event.source===document.querySelector("iframe")?.contentWindow && event.data?.type==="fixture-result")setProof(event.data);};window.addEventListener("message",listener);return()=>window.removeEventListener("message",listener);},[]);const[navigation,onChange]=useState(()=>browserNavigation(${JSON.stringify(fileURL)}));return <><div style={{height:500,display:"flex"}}><BrowserPanel navigation={navigation} onChange={onChange}/></div><output role="status">{JSON.stringify({native,...proof})}</output></>;}createRoot(document.getElementById('root')).render(<Fixture/>);`;},
 configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  if(req.url==='/__fixture_rpc'){
   if(req.method!=='POST'||req.headers.origin!==origin){res.statusCode=403;res.end();return;}
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
   const {op,params}=JSON.parse(Buffer.concat(chunks).toString());
   try{if(op==='desktop_browser_open'&&params.url===fileURL){const value=await documents.open(fileURL);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value}));}else if(op==='desktop_browser_release'){await documents.release(params.id);res.end(JSON.stringify({ok:true}));}else{res.statusCode=403;res.end();}}catch(error){res.end(JSON.stringify({ok:false,error:{code:'fixture_failed',message:String(error)}}));}return;
  }
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div><script type="module" src="/__local_browser_fixture.tsx"></script></body></html>'));return;}next();
 });}
 }],server:{host:'127.0.0.1',port:0},appType:'custom'});
await server.listen();const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('fixture address');origin=`http://127.0.0.1:${address.port}`;
await fs.writeFile('/tmp/desktop-local-browser-ready.json',JSON.stringify({origin,fileURL,temporary,pid:process.pid}));
process.stdout.write(origin+'\n');
let closing=false;async function close(){if(closing)return;closing=true;await documents.close();await server.close();await fs.rm(temporary,{recursive:true,force:true});process.exit();}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
