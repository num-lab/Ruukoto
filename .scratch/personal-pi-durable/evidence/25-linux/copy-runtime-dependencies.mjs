import * as fs from 'node:fs';
import * as path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const repo=fs.realpathSync('/tmp/ruukoto-command-config-20261017-cc89'),target='/tmp/ruukoto-command-25-linux-20261017/source';
const queue=['apps/ruukoto/node_modules/@earendil-works/chord','apps/ruukoto/node_modules/@earendil-works/pi-ai','node_modules/@earendil-works/pi-durable','node_modules/typebox'].map(p=>path.join(repo,p));
const visited=new Set(),records=[];
while(queue.length){
 const current=fs.realpathSync(queue.shift());if(visited.has(current))continue;visited.add(current);
 const manifest=JSON.parse(fs.readFileSync(path.join(current,'package.json'),'utf8')),require=createRequire(path.join(current,'package.json'));
 const destination=path.join(target,path.relative(repo,current));fs.mkdirSync(path.dirname(destination),{recursive:true});fs.cpSync(current,destination,{recursive:true});
 records.push({name:manifest.name,version:manifest.version,path:path.relative(repo,current),packageJsonSha256:createHash('sha256').update(fs.readFileSync(path.join(current,'package.json'))).digest('hex')});
 for(const name of Object.keys(manifest.dependencies??{})){
  const search=require.resolve.paths(name)??[],found=search.map(p=>path.join(p,name)).find(p=>fs.existsSync(path.join(p,'package.json')));
  if(!found)throw new Error(`missing installed dependency ${name} of ${manifest.name}`);queue.push(found);
 }
}
fs.writeFileSync('/tmp/ruukoto-command-25-linux-20261017/runtime-dependencies.json',JSON.stringify(records,null,2)+'\n');
process.stdout.write(JSON.stringify({packages:records.length})+'\n');
