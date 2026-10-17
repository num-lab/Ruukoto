import fs from 'node:fs';
import { registerHooks,syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
const output=process.env.RUUKOTO_QA_COLD_LOG;
if(!output?.startsWith('/tmp/ruukoto-code-cold-stages/'))throw new Error('QA output path missing');
const events=[];
function mark(stage){events.push({stage,wallMs:Date.now(),monoMs:+performance.now().toFixed(3),uptimeMs:+(process.uptime()*1000).toFixed(3)});}
function flush(){fs.writeFileSync(output,JSON.stringify({pid:process.pid,events},null,2)+'\n',{mode:0o600});}
globalThis.__qaColdMark=mark;
mark('node_preload_ready');
const markCode=stage=>`globalThis.__qaColdMark(${JSON.stringify(stage)});`;
function insert(source,pattern,replacement,name){if(!pattern.test(source))throw new Error('QA anchor missing: '+name);return source.replace(pattern,replacement);}
const anchors=[];
registerHooks({load(url,context,next){
 const target=url.split('?')[0];
 const bin=target.endsWith('/apps/ruukoto-code/bin/ruukoto-code.mjs'),main=target.endsWith('/apps/ruukoto-code/src/main.ts'),cli=target.endsWith('/packages/tui/src/cli.ts');
 if(!bin&&!main&&!cli)return next(url,context);
 const result=next(url,context);
 let source=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');
 if(bin){
  source=insert(source,/register\(\);?/,`${markCode('tsx_register_begin')}register();${markCode('tsx_register_end')}`,'tsx-register');
  source=insert(source,/await\s+import\(/,`${markCode('main_import_begin')}await import(`,'main-import');
  source=source.startsWith('#!')?source.replace(/^(#![^\n]*\n)/,`$1${markCode('bin_body')}`):markCode('bin_body')+source;source+='\n'+markCode('main_import_end');anchors.push('bin');
 }
 if(main){source=markCode('main_body')+source;anchors.push('main');}
 if(cli){
  source=insert(source,/(async\s+function\s+runCli\([^)]*\)[^{]*\{)/,`$1${markCode('runCli_begin')}`,'runCli');
  source=insert(source,/(async\s+function\s+runServer\([^)]*\)[^{]*\{)/,`$1${markCode('runServer_begin')}`,'runServer');
  source=insert(source,/(const\s*\{\s*Runtime\s*\}\s*=\s*await\s+import\([^;]+;)/,`${markCode('runtime_import_begin')}$1${markCode('runtime_import_end')}`,'runtime-import');
  source=insert(source,/(const\s*\{\s*ControlServer\s*\}\s*=\s*await\s+import\([^;]+;)/,`${markCode('control_import_begin')}$1${markCode('control_import_end')}`,'control-import');
  source=insert(source,/(const\s+runtime\s*=\s*await\s+Runtime\.start\()/,`${markCode('runtime_start_begin')}$1`,'runtime-start');
  source=insert(source,/await\s+ControlServer\.start\(runtime\);?/,`${markCode('runtime_start_end')}${markCode('control_start_begin')}await ControlServer.start(runtime);${markCode('control_start_end')}globalThis.__qaColdFlush();`,'control-start');
  anchors.push('cli');
 }
 return {...result,source};
}});
globalThis.__qaColdFlush=()=>{flush();};
const listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){
 if(args[0]===process.env.RUUKOTO_CODE_CONTROL_DIR+'/control.sock')this.once('listening',()=>{mark('control_socket_listening');flush();});
 return listen.apply(this,args);
};
syncBuiltinESMExports();
process.on('exit',()=>{mark('node_exit');flush();});
