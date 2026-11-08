import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "./helpers/vite.ts";

test("Desktop SSR fixtures render with React without starting client dependency optimization", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-ssr-test-")), cacheDir = path.join(root, "cache");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer", import.meta.url)),
    plugins: [react()], cacheDir, optimizeDeps: { force: true },
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
  });
  try {
    assert.equal(server.environments.client.depsOptimizer, undefined);
    assert.equal(server.config.optimizeDeps.noDiscovery, true);
    assert.deepEqual(server.config.optimizeDeps.include, []);
    const { Conversation } = await server.ssrLoadModule("/conversation.tsx");
    assert.ok(Conversation);
  } finally { await server.close(); }
  assert.equal(fs.existsSync(cacheDir), false);
});
