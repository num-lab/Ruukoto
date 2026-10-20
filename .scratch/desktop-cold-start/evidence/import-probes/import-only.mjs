import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const root = "/Users/eitrous/.codex/worktrees/6f13/ruukoto";
const require = createRequire(`${root}/package.json`);
const started = performance.now();
let last = started;
const mark = (phase) => { const now = performance.now(); process.stdout.write(JSON.stringify({phase, ms: +(now-last).toFixed(3), fromScriptMs: +(now-started).toFixed(3)})+"\n"); last=now; };
if (process.env.IMPORT_NATIVE !== "1") {
 const { register } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
 mark("importTsx"); register(); mark("registerTsx");
}
const targets = {
 cli: `${root}/packages/tui/src/cli.ts`,
 product: `${root}/apps/ruukoto-code/src/product.ts`,
 runtime: `${root}/packages/runtime/src/runtime.ts`,
 control: `${root}/packages/control/src/server.ts`,
 ai: `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
 coding: `${root}/node_modules/@earendil-works/pi-coding-agent/dist/index.js`,
 sdkmodel: `${root}/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js`,
 providers: `${root}/node_modules/@earendil-works/pi-ai/dist/providers/all.js`,
 mcp: `${root}/packages/agent/src/mcp/client.ts`,
};
for (const key of process.argv.slice(2)) {
 await import(pathToFileURL(targets[key] || key).href);
 mark(key);
}
mark("done");
