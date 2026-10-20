import { registerHooks } from "node:module";
const root="file:///Users/eitrous/.codex/worktrees/6f13/ruukoto/node_modules/";
const mappings=[
 [root+"@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/",root+"@earendil-works/pi-ai/"],
 [root+"@earendil-works/pi-coding-agent/node_modules/typebox/",root+"@earendil-works/pi-ai/node_modules/typebox/"],
];
registerHooks({resolve(specifier,context,next){const result=next(specifier,context);const mapping=mappings.find(([before])=>result.url.startsWith(before));return mapping?{...result,url:mapping[1]+result.url.slice(mapping[0].length)}:result;}});
