import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness } from "../../../../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../../../../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../../../../apps/ruukoto/src/personal-permissions.ts";
import { browserOperations, browserResolve } from "../../../../apps/ruukoto/src/personal-browser.ts";
import { loadPersonalArtifact, exportPersonalArtifact } from "../../../../apps/ruukoto/src/personal-artifacts.ts";
import { personalArtifactEntries } from "../../../../apps/ruukoto/src/personal-tools.ts";
import { MockModelServer, type Responder } from "../../../../test/helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const binaryPath = process.env.PROBE_BROWSER_BINARY ?? "/tmp/ruukoto-browser-v0391-c_t0kicm/agent-browser-darwin-arm64";
const chromePath = process.env.PROBE_BROWSER_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const invoke = (action: string, rest = {}) => "browser:" + JSON.stringify({ action, ...rest });
const respond: Responder = request => {
  const last = request.messages.at(-1), text = String(last?.content);
  return last?.role === "user" && text.startsWith("browser:") ? { kind: "tool_calls", calls: [{ id: "probe-call", name: "browser", arguments: JSON.parse(text.slice(8)) }] } : { kind: "text", text: last?.role === "tool" ? text : Array.isArray(last?.content) ? String(request.messages.findLast(message => message.role === "tool")?.content) : "独立聊天完成" };
};
async function until(check: () => boolean | Promise<boolean>, timeout = 30_000) { const end = Date.now() + timeout; while (!await check()) { assert.ok(Date.now() < end, "探针等待超时"); await delay(25); } }
function options(directory: string, baseUrl: string) {
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl, modelId: "mock-model", apiKeyEnv: "RK_BROWSER_PROBE_KEY", contextWindow: 128000, maxTokens: 8192, imageInput: true };
  return { directory, provider: personalProvider(config), modelId: config.modelId, browser: { version: 1 as const, generation: "probe-v1", binaryPath, chromePath, headed: false } };
}
process.env.RK_BROWSER_PROBE_KEY = "local-probe-only";
if (process.argv[2] === "crash-child") {
  const personal = await openPersonalHarness(options(process.argv[3], process.argv[4]));
  await personal.answer(invoke("start"), "crash-start");
  await personal.answer(invoke("open", { url: process.argv[5] }), "crash-navigation");
  throw new Error("应由父进程在真实导航中强杀");
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk30-real-browser-"))), directory = path.join(root, "profile");
const model = new MockModelServer(respond), baseUrl = await model.start();
let crashRequests = 0, cancelRequests = 0;
const site = http.createServer((req, res) => {
  if (req.url === "/crash") { crashRequests++; return; }
  if (req.url === "/cancel") { cancelRequests++; return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><html lang="zh"><title>个人浏览器探针</title><h1>真实页面</h1><label>备注<input id="note"></label><button onclick="document.querySelector(\'h1\').textContent=\'已确认\'">确认</button></html>');
});
site.listen(0, "127.0.0.1"); await once(site, "listening");
const address = site.address(); assert.ok(address && typeof address === "object"); const url = `http://127.0.0.1:${address.port}`;
let personal: Awaited<ReturnType<typeof openPersonalHarness>> | undefined;
let child: ReturnType<typeof spawn> | undefined;
const facts: Record<string, unknown> = { environment: { platform: process.platform, arch: process.arch, node: process.version }, model: "loopback替身，非真实视觉模型", browser: { binaryPath, chromePath } };
try {
  personal = await openPersonalHarness(options(directory, baseUrl));
  await personal.harness.commit(async tx => { const value = await tx.doc(PersonalPermissionsDoc); value.mode = "full_access"; value.version++; }, context);
  assert.equal(JSON.parse(await personal.answer(invoke("start"), "start")).code, "returned");
  assert.equal(JSON.parse(await personal.answer(invoke("open", { url }), "open")).code, "returned");
  const snapshot = JSON.parse(await personal.answer(invoke("snapshot"), "snapshot"));
  const refs = snapshot.result?.refs; assert.ok(refs && Object.keys(refs).length > 0);
  const shot = JSON.parse(await personal.answer(invoke("screenshot"), "screenshot")); assert.ok(shot.artifact);
  const artifact = await personal.harness.commit(async tx => JSON.parse(JSON.stringify((await personalArtifactEntries(tx)).find(value => value.artifact.id === shot.artifact)!.artifact)), context);
  const bytes = loadPersonalArtifact(directory, artifact); assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  await exportPersonalArtifact(directory, artifact, path.join(root, "screenshot.png")); assert.deepEqual(fs.readFileSync(path.join(root, "screenshot.png")), bytes);
  assert.ok(model.calls.some(call => JSON.stringify(call.raw).includes("data:image/png;base64,")));
  await personal.answer(invoke("pause"), "pause"); assert.equal(personal.browser!.status().state, "paused");
  await personal.answer(invoke("resume"), "resume-new-owner-input"); assert.equal(personal.browser!.status().state, "ready");
  await personal.answer(invoke("close"), "close"); assert.equal(personal.browser!.status().state, "closed");
  facts.normal = { snapshotRefs: Object.keys(refs).length, screenshotBytes: bytes.length, sha256: artifact.sha256, pauseResume: true, export: true, state: personal.browser!.status() };
  await personal.close(); personal = undefined;
  child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "crash-child", directory, baseUrl, url + "/crash"], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stderr!.on("data", value => { output += value; });
  await until(() => crashRequests === 1 || child!.exitCode !== null); assert.equal(crashRequests, 1, output);
  child.kill("SIGKILL"); await once(child, "exit"); child = undefined;
  personal = await openPersonalHarness(options(directory, baseUrl));
  await until(async () => await personal!.harness.commit(async tx => (await browserOperations(tx)).some(value => value.origin.source.requestId === "crash-navigation" && value.code === "interrupted"), context));
  const crashed = await personal.harness.commit(async tx => JSON.parse(JSON.stringify((await browserOperations(tx)).find(value => value.origin.source.requestId === "crash-navigation"))), context);
  assert.equal(crashed.effect, "effect_unknown"); assert.equal(crashed.stopped, true); assert.equal(crashRequests, 1); assert.equal(personal.browser!.status().state, "closed");
  assert.equal(await personal.answer("独立聊天", "after-crash"), "独立聊天完成");
  await assert.rejects(personal.work.delegate({ requestId: "blocked-crash-work", sourceRequestId: "crash-navigation", content: "不能绕过原未知" }), { code: "work_source_paused" });
  await personal.harness.commit(tx => browserResolve(tx, crashed.operation, "applied", "本机探针服务器已观察到一次原导航GET；不据此宣称其他网站写入可回滚。"), context);
  facts.crash = { requests: crashRequests, effect: crashed.effect, stopped: crashed.stopped, browserState: personal.browser!.status().state, sourceBlocked: true, independentChat: true };
  await personal.answer(invoke("start"), "cancel-start");
  const submission = await personal.submit(invoke("open", { url: url + "/cancel" }), "cancel-navigation");
  await until(() => cancelRequests === 1); await personal.main.abort(context); await submission.wait(context);
  await until(async () => await personal!.harness.commit(async tx => (await browserOperations(tx)).some(value => value.origin.source.requestId === "cancel-navigation" && value.observation), context));
  const canceled = await personal.harness.commit(async tx => JSON.parse(JSON.stringify((await browserOperations(tx)).find(value => value.origin.source.requestId === "cancel-navigation"))), context);
  assert.equal(canceled.effect, "effect_unknown"); assert.equal(canceled.stopped, true); assert.equal(personal.browser!.status().state, "closed"); assert.equal(cancelRequests, 1);
  facts.cancel = { requests: cancelRequests, effect: canceled.effect, stopped: canceled.stopped, browserState: personal.browser!.status().state };
  await personal.close(); personal = undefined;
  facts.passed = true;
} finally {
  if (child) { child.kill("SIGKILL"); await once(child, "exit"); }
  await personal?.close(); await model.close(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve()));
  fs.writeFileSync(path.join(import.meta.dirname, "browser-probe-result.json"), JSON.stringify(facts, null, 2) + "\n");
  fs.rmSync(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(facts) + "\n");
