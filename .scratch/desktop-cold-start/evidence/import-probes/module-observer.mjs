import fs from "node:fs";
import { registerHooks } from "node:module";
const modules=new Map(), edges=[];
registerHooks({
 resolve(specifier,context,next){const result=next(specifier,context);if(result.url.startsWith("file:"))edges.push({from:context.parentURL,to:result.url});return result;},
 load(url,context,next){const result=next(url,context);if(url.startsWith("file:"))modules.set(url,{url,format:result.format,bytes:result.source===null||result.source===undefined?null:Buffer.byteLength(result.source)});return result;}
});
process.once("exit",()=>fs.writeFileSync("/tmp/ruukoto-cold-import-audit/module-graph.json",JSON.stringify({modules:[...modules.values()],edges},null,2)+"\n",{mode:0o600}));
