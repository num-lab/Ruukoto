import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const [repo,root,phase]=process.argv.slice(2);const {assertGrantsNotProtected,ApprovedOpError}=await import(pathToFileURL(path.join(repo,'packages/agent/src/execution/approved-ops.ts')));
const source=path.join(root,'private','nested','source'),alias=path.join(root,'safe','alias'),other=path.join(root,'safe','other');
const a=fs.statSync(source,{bigint:true}),b=fs.statSync(alias,{bigint:true});
if(phase==='mounted'){assert.equal(a.dev,b.dev);assert.equal(a.ino,b.ino);assert.equal(a.nlink,1n);assert.equal(b.nlink,1n);assert.throws(()=>assertGrantsNotProtected([other,alias],[path.join(root,'private')]),ApprovedOpError)}
else {assert.notEqual(a.ino,b.ino);assert.doesNotThrow(()=>assertGrantsNotProtected([other,alias],[path.join(root,'private')]))}
process.stdout.write(JSON.stringify({phase,passed:true,source:{dev:String(a.dev),ino:String(a.ino),nlink:String(a.nlink)},alias:{dev:String(b.dev),ino:String(b.ino),nlink:String(b.nlink)},node:process.version})+'\n');
