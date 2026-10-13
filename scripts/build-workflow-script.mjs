import { build } from "esbuild";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Note: 见 .agents/notes/implemented/architecture/2026-10-13-workflow-script-isolation.md
const root = fileURLToPath(new URL("../", import.meta.url));
const requireAgent = createRequire(new URL("../packages/agent/package.json", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["packages/agent/src/script-worker/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22.19",
  outfile: "worker/workflow-script.mjs",
});
fs.copyFileSync(requireAgent.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"), new URL("../worker/workflow-script.wasm", import.meta.url));
