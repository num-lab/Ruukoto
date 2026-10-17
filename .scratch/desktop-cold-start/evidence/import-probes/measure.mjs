import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
const base = "/tmp/ruukoto-cold-import-audit";
for(const mode of ["cached", "cacheless", "native"]){
 const tmp = `${base}/tmp-${mode}`; mkdirSync(tmp,{recursive:true});
 for(let round=1;round<=3;round++){
  const start=performance.now();
  let stdout;
  try { stdout=execFileSync(process.execPath,[...(mode==="native"?["--experimental-transform-types"]:[]), `${base}/import-only.mjs`, ...process.argv.slice(2)],{env:{...process.env,TMPDIR:tmp,TSX_DISABLE_CACHE:mode==="cacheless"?"1":"",IMPORT_NATIVE:mode==="native"?"1":""},timeout:20000,encoding:"utf8",stdio:["ignore","pipe","pipe"]}); }
  catch(error){ process.stdout.write(JSON.stringify({mode,round,error:error.stderr?.toString().slice(-2000) || error.message})+"\n"); continue; }
  process.stdout.write(JSON.stringify({mode,round,processMs:+(performance.now()-start).toFixed(3),stages:stdout.trim().split("\n").map(JSON.parse)})+"\n");
 }
}
