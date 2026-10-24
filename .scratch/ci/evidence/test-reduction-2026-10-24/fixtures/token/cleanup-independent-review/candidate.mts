import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { build } from "esbuild";
import { ControlClient } from "@ruukoto/control/client.ts";
import { personalDevDirectory, personalDevelopmentEnv, savePersonalConfig } from "/Users/eitrous/Developer/ruukoto/apps/ruukoto/src/personal-config.ts";
import { lockPersonalProfile } from "/Users/eitrous/Developer/ruukoto/apps/ruukoto/src/personal-profile.ts";
import { personalControl, startPersonalServer, type PersonalStatus } from "/Users/eitrous/Developer/ruukoto/apps/ruukoto/src/personal-control.ts";
import { savePersonalTelegram } from "/Users/eitrous/Developer/ruukoto/apps/ruukoto/src/personal-telegram-config.ts";
import { PersonalError } from "/Users/eitrous/Developer/ruukoto/apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer as MockModelServer } from "/Users/eitrous/Developer/ruukoto/test/helpers/mock-provider.ts";
import { authenticateClient, cleanupDirs, makeTestDirs, writeModelsJson } from "/Users/eitrous/Developer/ruukoto/test/helpers/testkit.ts";

const root = fileURLToPath(new URL("file:///Users/eitrous/Developer/ruukoto/"));
const bin = path.join(root, "apps/ruukoto/bin/ruukoto.mjs");
const execute = promisify(execFile);
const code = (value: string) => (error: unknown) => error instanceof PersonalError && error.code === value;
type EntryCleanup = { children: (() => Promise<void>)[]; models: (() => Promise<void>)[]; directories: (() => void | Promise<void>)[] };
const cleanupByTest = new WeakMap<TestContext, EntryCleanup>();
function cleanupFor(t: TestContext): EntryCleanup {
  const existing = cleanupByTest.get(t);
  if (existing) return existing;
  const resources: EntryCleanup = { children: [], models: [], directories: [] };
  cleanupByTest.set(t, resources);
  t.after(async () => {
    const failures: unknown[] = [];
    for (const phase of [resources.children, resources.models, resources.directories]) for (const release of phase.toReversed()) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) process.stderr.write(`[ruukoto:test] 入口夹具清理失败：${failures.map(String).join("；")}\n`);
    if (failures.length) throw new AggregateError(failures, "入口夹具清理失败");
  });
  return resources;
}
const temp = (t: TestContext) => {
  const dir = fs.mkdtempSync("/tmp/r38-");
  cleanupFor(t).directories.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) { assert.ok(Date.now() < deadline, "入口未在期限内就绪或停止"); await delay(20); }
}
function child(t: TestContext, argv: string[], env: NodeJS.ProcessEnv) {
  const processChild = spawn(process.execPath, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  processChild.stdout!.on("data", value => { output += String(value); });
  processChild.stderr!.on("data", value => { output += String(value); });
  const closed = new Promise<number | null>((resolve, reject) => { processChild.once("error", reject); processChild.once("close", resolve); });
  cleanupFor(t).children.push(async () => {
    if (processChild.exitCode === null && processChild.signalCode === null) {
      processChild.kill("SIGTERM");
      const timer = setTimeout(() => processChild.kill("SIGKILL"), 5000);
      try { await closed; } finally { clearTimeout(timer); }
    }
  });
  return { process: processChild, closed, output: () => output };
}
async function ready(directory: string, processChild: ChildProcess, output: () => string) {
  await until(async () => {
    assert.equal(processChild.exitCode, null, output());
    try { await personalControl(directory, "GET", "/status"); return true; } catch (error) {
      if (!(error instanceof PersonalError) || !["control_unavailable", "control_starting", "control_response_lost"].includes(error.code)) throw error;
      return false;
    }
  });
}
async function fixture(t: TestContext, directory = temp(t)) {
  const model = new MockModelServer(() => ({ kind: "text", text: "ENTRY_OK" }));
  const baseUrl = await model.start();
  cleanupFor(t).models.push(() => model.close());
  await savePersonalConfig(directory, { api: "openai-completions", baseUrl, modelId: "mock-model", apiKeyEnv: "R38_MODEL_KEY", contextWindow: 128000, maxTokens: 1024 });
  return { directory, model, baseUrl, env: { RUUKOTO_PERSONAL_DIR: directory, R38_MODEL_KEY: "test-only" } };
}


import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const evidence = process.argv[2];
const record = (event: Record<string, unknown>) => fs.appendFileSync(evidence, JSON.stringify({ ...event, at: Date.now() }) + "\n");
test("受控入口失败仍须按子进程、mock、目录清理", async t => {
  const f = await fixture(t);
  const modelClose = f.model.close.bind(f.model);
  f.model.close = async () => { record({ action: "model-close-start" }); await modelClose(); record({ action: "model-closed" }); throw new Error("controlled_model_cleanup_failure"); };
  const marker = path.join(f.directory, "child-ready");
  const backend = child(t, ["--input-type=module", "--eval", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);`], {});
  backend.process.once("close", (code, signal) => record({ action: "child-closed", code, signal }));
  await until(() => fs.existsSync(marker));
  cleanupFor(t).children.push(async () => { record({ action: "first-child-cleanup-failed" }); throw new Error("controlled_child_cleanup_failure"); });
  record({ action: "resources-ready", directory: f.directory, child: backend.process.pid, model: f.baseUrl });
  const remove = fsDefault.rmSync;
  fsDefault.rmSync = (filename, options) => {
    if (filename === f.directory) { record({ action: "directory-remove-start" }); throw new Error("controlled_directory_cleanup_failure"); }
    return remove(filename, options);
  };
  syncBuiltinESMExports();
  throw new Error("controlled_test_body_failure");
});
