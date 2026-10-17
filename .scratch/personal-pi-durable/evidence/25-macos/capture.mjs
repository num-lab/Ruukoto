import * as fs from 'node:fs';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
const {MockModelServer}=await import(pathToFileURL(path.join(process.cwd(),'test/helpers/mock-provider.ts')).href);
const close=MockModelServer.prototype.close;
MockModelServer.prototype.close=async function(...args){
  if(this.calls.some(call=>JSON.stringify(call.tools).includes('run_command'))) fs.writeFileSync('/tmp/ruukoto-command-model-snapshot.json',JSON.stringify(this.calls,null,2)+'\n');
  return close.apply(this,args);
};
