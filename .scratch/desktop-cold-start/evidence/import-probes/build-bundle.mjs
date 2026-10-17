import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const root="/Users/eitrous/.codex/worktrees/6f13/ruukoto";
const require=createRequire(`${root}/package.json`);
const {build}=require("esbuild");
const manifests=[`${root}/package.json`,...fs.readdirSync(`${root}/packages`).map(p=>`${root}/packages/${p}/package.json`)];
const external=[...new Set(manifests.flatMap(p=>{const m=JSON.parse(fs.readFileSync(p,"utf8"));return Object.keys({...m.dependencies,...m.optionalDependencies});}).filter(name=>!name.startsWith("@ruukoto/")))];
const result=await build({absWorkingDir:root,entryPoints:[`${root}/packages/runtime/src/runtime.ts`],outfile:"/tmp/ruukoto-cold-import-audit/runtime-bundled.mjs",bundle:true,platform:"node",target:"node24",format:"esm",external,metafile:true,write:true,logLevel:"silent"});
fs.writeFileSync("/tmp/ruukoto-cold-import-audit/metafile.json",JSON.stringify(result.metafile));
try { fs.symlinkSync(`${root}/node_modules`,"/tmp/ruukoto-cold-import-audit/node_modules"); }catch(e){if(e.code!=="EEXIST")throw e;}
process.stdout.write(JSON.stringify({inputs:Object.keys(result.metafile.inputs).length,outputs:Object.values(result.metafile.outputs).map(v=>v.bytes),external})+"\n");
