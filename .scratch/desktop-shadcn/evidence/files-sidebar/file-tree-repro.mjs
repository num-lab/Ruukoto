import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = resolve(process.argv[2] ?? process.cwd());
const require = createRequire(root + '/package.json');
const React = require('react'), {renderToStaticMarkup} = require('react-dom/server');
// Note: 见 .agents/notes/implemented/testing/2026-10-22-ci-prerequisites.md
const server = await createServer({configFile:false,root:root+'/apps/desktop/src/renderer',plugins:[react()],ssr:{noExternal:['@xterm/xterm','@xterm/addon-fit']},server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});
try {
  const {WorkspaceFiles} = await server.ssrLoadModule('/inspector-panels.tsx');
  const directories = new Map(), folders = new Map(), requests = [];
  const inspector = {directories,folders,fileKey:(workspace,path)=>workspace+':'+path,loadDirectory(workspace,path,retry=false){
    const key=this.fileKey(workspace,path);
    if(directories.has(key)&&!retry)return Promise.resolve();
    requests.push(path);directories.set(key,{loading:true,value:directories.get(key)?.value});return Promise.resolve();
  }};
  const model = {view:{projects:[{id:'w',name:'测试工作区'}]},status:{state:'online'},inspector,refresh(){}};
  const html = () => renderToStaticMarkup(React.createElement(WorkspaceFiles,{model,workspaceId:'w'}));
  directories.set('w:',{loading:true});
  assert.match(html(),/role="status"[^>]*aria-label="正在加载文件树"/,'首读必须显示可访问加载图标');
  assert.doesNotMatch(html(),/正在读取/);
  const page = entries => ({workspaceId:'w',path:'',entries,truncated:false});
  directories.set('w:',{loading:false,value:page([{kind:'directory',name:'src',path:'src'}])});
  function folder() {
    const shared=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,previous=shared.H;
    shared.H={useEffect(){}};
    let result;
    function visit(node){
      if(!node||typeof node!=='object')return;
      if(Array.isArray(node)){node.forEach(visit);return;}
      if(typeof node.type==='function'&&['Directory','DirectoryFolder'].includes(node.type.name)){visit(node.type(node.props));return;}
      if(node.props?.onOpenChange)result??=node;
      React.Children.forEach(node.props?.children,visit);
    }
    try{visit(WorkspaceFiles({model,workspaceId:'w'}));}finally{shared.H=previous;}
    assert.ok(result,'找到实际文件夹Collapsible');return result;
  }
  folder().props.onOpenChange(true);
  assert.deepEqual(requests,['src'],'点击必须启动尚未挂载子目录的读取');
  assert.equal(folder().props.open,false,'读取中不展开');
  assert.match(html(),/class="file-tree-loading"[^>]*role="status"/,'加载图标在文件夹行内');
  assert.doesNotMatch(html(),/正在读取|暂无文件/);
  folder().props.onOpenChange(true);
  directories.set('w:src',{loading:false,value:{...page([]),path:'src'}});
  assert.equal(folder().props.open,false,'读取中再次点击撤销展开');
  folder().props.onOpenChange(true);
  assert.equal(folder().props.open,true,'缓存已完成时立即展开');
  assert.doesNotMatch(html(),/暂无文件/,'空文件夹不输出提示');
  directories.set('w:src',{loading:true,value:{...page([{kind:'file',name:'a.ts',path:'src/a.ts'}]),path:'src'}});
  assert.equal(folder().props.open,true,'刷新中保留已展开缓存');
  assert.match(html(),/预览 src\/a.ts/);
  directories.set('w:src',{loading:false,error:'目录读取失败'});
  assert.equal(folder().props.open,true,'首次失败也应露出错误');
  assert.match(html(),/role="alert">目录读取失败/);assert.match(html(),/重试/);
  directories.set('w:',{loading:false,value:page([])});
  assert.doesNotMatch(html(),/暂无文件/,'空根目录不输出提示');
  const {InspectorPanel} = await server.ssrLoadModule('/inspector-panel.tsx');
  inspector.repositories = new Map([['w',{loading:true}]]);
  inspector.workspace=()=>({id:'w',name:'测试工作区'}); inspector.activeTab=()=>({kind:'new'});
  inspector.tabs=()=>[]; inspector.terminalTabs=()=>[]; inspector.selectedTool=()=>null; inspector.agents=()=>[]; model.target='code';
  const landing=()=>renderToStaticMarkup(React.createElement(InspectorPanel,{model,open:true,onWidthChange(){}}));
  assert.doesNotMatch(landing(),/正在检测 Git|正在读取 Git|工具差异|SubAgent/,'新标签页无检测提示和差异清单');
  assert.match(landing(),/文件树/);assert.match(landing(),/浏览器/);
  inspector.repositories.set('w',{loading:false,error:'Git 检测失败'});
  assert.match(landing(),/role="alert"/);assert.match(landing(),/Git 检测失败/);assert.match(landing(),/重试/);
  process.stdout.write('PASS: root/folder spinners, delayed expansion, cancellation, cache, error and empty folders\n');
} finally { await server.close(); }
