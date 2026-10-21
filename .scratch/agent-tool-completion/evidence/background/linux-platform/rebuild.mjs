import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const directory=path.dirname(fileURLToPath(import.meta.url));
const repository=process.argv[2];
if(!repository)throw new Error("Usage: node rebuild.mjs <repository-with-esbuild>");
const {build}=await import(pathToFileURL(path.join(repository,"node_modules/esbuild/lib/main.js")));
for(const kind of ["real","checks"]){
 await build({entryPoints:[path.join(directory,`entry-${kind}.mjs`)],bundle:true,format:"esm",platform:"node",target:"node24",outfile:path.join(directory,`repro-${kind}.mjs`)});
}
await build({entryPoints:["native-linux-identity.test.ts","101-native-linux-scope.test.ts"].map(name=>path.join(directory,"source/test",name)),bundle:true,format:"esm",platform:"node",target:"node24",outdir:path.join(directory,"repro-tests"),plugins:[{name:"snapshot-agent-exports",setup(builder){builder.onResolve({filter:/^@ruukoto\/agent\//},args=>({path:path.join(directory,"source/packages/agent/src",args.path.slice("@ruukoto/agent/".length))}));}}]});
fs.writeFileSync(path.join(directory,"rebuild-complete.json"),JSON.stringify({repository,node:process.version})+"\n");
