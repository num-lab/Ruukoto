import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root=resolve(process.argv[2] ?? process.cwd());
const require=createRequire(root+'/package.json');
const React=require('react');
const { createServer }=await import(pathToFileURL(root+'/node_modules/vite/dist/node/index.js'));
const { default:react }=await import(pathToFileURL(root+'/node_modules/@vitejs/plugin-react/dist/index.js'));
const server=await createServer({configFile:false,root:root+'/apps/desktop/src/renderer',plugins:[react()],server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});
try {
 const {WorkspaceFiles}=await server.ssrLoadModule('/inspector-panels.tsx');
 const effects=[],requests=[];
 const inspector={directories:new Map(),folders:new Map(),loadDirectory:(...params)=>{requests.push(params)},fileKey:(w,p)=>w+':'+p};
 const model={view:{projects:[]},status:{state:'online'},inspector};
 const shared=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,previous=shared.H;
 shared.H={useEffect:(fn)=>effects.push(fn)};
 try {
  const element=WorkspaceFiles({model,workspaceId:'workspace',active:false});
  const visit=(node)=>{if(!node||typeof node!=='object')return;if(typeof node.type==='function'&&node.type.name==='Directory'){node.type(node.props);return;}for(const child of React.Children.toArray(node.props?.children))visit(child)};
  visit(element);
 } finally {shared.H=previous;}
 for(const effect of effects)effect();
 assert.deepEqual(requests, [], '关闭的文件树不能读取目录');
 process.stdout.write(JSON.stringify({active:false,effects:effects.length,requests})+'\n');
} finally {await server.close()}
