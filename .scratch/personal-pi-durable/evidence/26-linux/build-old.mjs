import * as fs from 'node:fs';
import * as path from 'node:path';
import {execFileSync} from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const repo='/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable';
const local='/tmp/ruukoto-full-26-linux.9wDa5g';
const remote='/tmp/ruukoto-full-26.R7idsd';
const {build}=await import(pathToFileURL(path.join(repo,'node_modules/esbuild/lib/main.js')));
const sha=value=>createHash('sha256').update(value).digest('hex');
const outfile=path.join(local,'source/apps/ruukoto/src/linux-command-probe-old.mjs');
const result=await build({entryPoints:[path.join(local,'old-entry.mjs')],bundle:true,external:['@earendil-works/*','typebox'],format:'esm',platform:'node',target:'node24',outfile,metafile:true,banner:{js:"import { createRequire as probeCreateRequire } from 'node:module'; const require = probeCreateRequire(import.meta.url);"},
  plugins:[{name:'preserve-module-urls',setup(builder){builder.onLoad({filter:/\.ts$/},async args=>{
    if(!args.path.startsWith('/private'+repo+'/')&&!args.path.startsWith(repo+'/'))return;
    const realRepo=fs.realpathSync(repo),relative=path.relative(realRepo,fs.realpathSync(args.path));
    if(relative.includes('node_modules/'))return;
    const source=execFileSync('git',['show','89b37f3:'+relative],{cwd:repo,encoding:'utf8'}),url=pathToFileURL(path.join(remote,'source',relative)).href;
    return{contents:source.replaceAll('import.meta.url',JSON.stringify(url)),loader:'ts',resolveDir:path.dirname(args.path)};
  });}}]});
fs.writeFileSync(path.join(local,'old-metafile.json'),JSON.stringify(result.metafile,null,2)+'\n');
const realRepo=fs.realpathSync(repo),files=Object.keys(result.metafile.inputs).map(p=>path.resolve(p)).filter(p=>p.startsWith(realRepo+'/')&&!p.includes('/node_modules/'));
const records=[];
for(const file of files){const relative=path.relative(realRepo,file),dest=path.join(local,'old-source',relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,execFileSync('git',['show','89b37f3:'+relative],{cwd:repo}));records.push({path:relative,sha256:sha(fs.readFileSync(dest))});}
const worker='worker/personal-command-worker.mjs';fs.mkdirSync(path.join(local,'source/worker'),{recursive:true});fs.copyFileSync(path.join(repo,worker),path.join(local,'source',worker));records.push({path:worker,sha256:sha(fs.readFileSync(path.join(repo,worker)))});
fs.writeFileSync(path.join(local,'old-source-manifest.json'),JSON.stringify({records,bundleSha256:sha(fs.readFileSync(outfile)),probeSha256:sha(fs.readFileSync(path.join(local,'old-entry.mjs'))),remote,moduleUrlStrategy:'each original repository TypeScript module uses its own absolute URL under remote source'},null,2)+'\n');
process.stdout.write(JSON.stringify({sourceFiles:records.length,bytes:fs.statSync(outfile).size,output:outfile})+'\n');
