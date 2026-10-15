import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { startTestRuntime, realTools, waitFor, lastUserText } from "/Users/eitrous/Developer/ruukoto/test/helpers/testkit.ts";
import { product } from "/Users/eitrous/Developer/ruukoto/apps/ruukoto-code/src/product.ts";

const root = "/Users/eitrous/Developer/ruukoto";
const require = createRequire(path.join(root, "package.json"));
const packaged = process.env.D07_PACKAGED === "1";
const appEntry = packaged ? path.join(root, "dist/mac-arm64/Ruukoto.app/Contents/Resources/app.asar/out/main/index.js") : path.join(root, "apps/desktop/out/main/index.js");
const evidenceDir = fs.mkdtempSync("/tmp/ruukoto-d07-evidence-");
const controlDir = fs.mkdtempSync("/tmp/d07-control-");
const smallBefore = "alpha\nbefore\nomega\n";
const smallAfter = "alpha\nafter\nomega\n";
const largeBefore = Array.from({ length: 900 }, (_, i) => `old-${String(i).padStart(4, "0")}-${"a".repeat(85)}\n`).join("");
const largeAfter = Array.from({ length: 900 }, (_, i) => `new-${String(i).padStart(4, "0")}-${"b".repeat(85)}\n`).join("");
let childHeld = false;
let releaseChild!: () => void;
const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
let readFile = "";
const outcomes: Record<string, unknown>[] = [];
const mark = (name: string, data: Record<string, unknown> = {}) => { outcomes.push({ name, ...data }); process.stdout.write(`${name}\n`); };
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify(value, null, 2) + "\n");

const t = await startTestRuntime("d07-real-gui", async req => {
  const input = lastUserText(req);
  const lastUser = req.messages.map(message => message.role).lastIndexOf("user");
  const hasTool = req.messages.slice(lastUser + 1).some(message => message.role === "tool");
  if (input.includes("[SubAgent 委派")) {
    if (!hasTool) return { kind: "tool_calls", calls: [{ id: "child-read", name: "read", arguments: { path: readFile } }] };
    childHeld = true;
    await childGate;
    return { kind: "text", text: "子会话最终回答：真实读取完成，没有丢失历史。" };
  }
  if (input.includes("d07-subagent")) {
    if (!hasTool) return { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: { request: "d07-child：读取指定文件并回答；等待验收继续。", key: "d07-child", read_paths: [readFile] } }] };
    return { kind: "text", text: "主会话已委派，子会话继续运行。" };
  }
  if (input.includes("d07-files")) {
    if (hasTool) return { kind: "text", text: "真实 edit/write 工具验收结束。" };
    return { kind: "tool_calls", calls: [
      { id: "edit-small", name: "edit", arguments: { path: "small.txt", edits: [{ oldText: smallBefore, newText: smallAfter }] } },
      { id: "edit-large", name: "edit", arguments: { path: "large.txt", edits: [{ oldText: largeBefore, newText: largeAfter }] } },
      { id: "write-new", name: "write", arguments: { path: "new.txt", content: "新文件正文\n中文👩‍💻\n" } },
      { id: "write-empty", name: "write", arguments: { path: "empty.txt", content: "" } },
      { id: "write-failed", name: "write", arguments: { path: "blocked", content: "never written\n" } },
    ] };
  }
  return { kind: "text", text: "验收备用回复。" };
}, { contextWindow: 1_000_000, workDirs: 1, config: { product: product.runtime, ...realTools() } });

let electron: ChildProcess | undefined;
let ws: WebSocket | undefined;
let stderr = "";
let cdpId = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: unknown) => void }>();
const runtimeMessages: unknown[] = [];
let success = false;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const cdp = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
  const id = ++cdpId;
  pending.set(id, { resolve, reject });
  ws!.send(JSON.stringify({ id, method, params }));
});
const evaluate = async <T = any>(expression: string): Promise<T> => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value as T;
};
const screenshot = async (name: string) => {
  const result = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(evidenceDir, name), Buffer.from(result.data, "base64"));
};
const waitDom = (description: string, expression: string) => waitFor(description, () => evaluate<boolean>(expression), 20_000);
const dom = () => evaluate(`({ body: document.body.innerText, width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth, inspectors:document.querySelectorAll('.inspector').length, errors:[...document.querySelectorAll('[role="alert"]')].map(x=>x.textContent), buttons:[...document.querySelectorAll('button')].map(x=>({text:x.textContent,disabled:x.disabled})) })`);
const clickDiff = async (target: string) => {
  await evaluate(`(()=>{const row=[...document.querySelectorAll('.canvas .tool-row')].find(row=>row.querySelector('pre')?.textContent===${JSON.stringify(target)});if(!row)throw Error('tool row missing');row.closest('details').open=true;row.querySelector('.diff-link').click();return true})()`);
  await waitDom(`差异 ${target} 完成读取`, `document.querySelector('.diff-target')?.textContent===${JSON.stringify(target)} && !document.querySelector('.diff-state')?.textContent?.includes('正在读取')`);
};
const diffDom = () => evaluate(`({header:document.querySelector('.diff-content header')?.textContent,target:document.querySelector('.diff-target')?.textContent,text:document.querySelector('.diff-content')?.innerText,patch:[...document.querySelectorAll('.patch span')].map(x=>({kind:x.className,text:x.textContent})),write:document.querySelector('.write-content')?.textContent??null,truncated:document.querySelector('.diff-truncated')?.textContent??null,state:document.querySelector('.diff-state')?.textContent??null})`);
const childDom = () => evaluate(`({messages:[...document.querySelectorAll('.inspector .message .markdown')].map(x=>x.textContent),thinking:[...document.querySelectorAll('.inspector .thinking .markdown')].map(x=>x.textContent),tools:[...document.querySelectorAll('.inspector .tool-row')].map(x=>({name:x.querySelector('strong,.diff-link')?.textContent,target:x.querySelector('pre')?.textContent,summary:[...x.querySelectorAll('pre')].slice(1).map(y=>y.textContent),status:x.querySelector('.tool-status')?.textContent})),task:[...document.querySelectorAll('.inspector .task-status')].map(x=>x.textContent),selected:[...document.querySelectorAll('.agent-choice[aria-pressed="true"]')].map(x=>x.textContent)})`);

try {
  const work = t.work[0];
  fs.writeFileSync(path.join(work, "small.txt"), smallBefore);
  fs.writeFileSync(path.join(work, "large.txt"), largeBefore);
  fs.mkdirSync(path.join(work, "blocked"));
  readFile = path.join(work, "child-read.txt");
  fs.writeFileSync(readFile, "子会话真实读取：中文与 emoji 👩‍💻。\n");
  readFile = fs.realpathSync(readFile);
  fs.symlinkSync(path.join(t.runtime.controlDir(), "owner.token"), path.join(controlDir, "owner.token"));
  fs.symlinkSync(t.runtime.socketPath(), path.join(controlDir, "control.sock"));
  const opened = await t.runtime.openWorkspace({ cwd: work });
  const session = opened.session;
  const bootstrap = path.join(evidenceDir, "bootstrap.cjs");
  fs.writeFileSync(bootstrap, `const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(evidenceDir, "app-profile"))});
app.commandLine.appendSwitch('remote-debugging-port','0');
const command=${JSON.stringify(path.join(evidenceDir, "window-command"))};let previous='';
setInterval(()=>{if(!fs.existsSync(command))return;const value=fs.readFileSync(command,'utf8');if(value===previous)return;previous=value;if(value==='quit')app.quit();if(value==='small')BrowserWindow.getAllWindows()[0]?.setSize(760,500);},100);
import(${JSON.stringify(new URL("file://" + appEntry).href)});
`);
  save("environment.json", { date: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, root, evidenceDir, backend: "real temporary Code Runtime and ControlServer", model: "local deterministic MockModelServer", tools: "realTools() and actual tool worker; test local execution, native sandbox not covered", dailyProfileAccessed: false, launchSource: packaged ? "final packaged app.asar main/preload/renderer under installed identical Electron" : "final apps/desktop/out main/preload/renderer", app: path.relative(root, appEntry), executable: require("electron"), packagedArchiveSha256: packaged ? createHash("sha256").update(fs.readFileSync(path.join(root, "dist/mac-arm64/Ruukoto.app/Contents/Resources/app.asar"))).digest("hex") : null, sessionId: session.id, instanceId: t.runtime.db.getInstanceId() });
  electron = spawn(require("electron"), [bootstrap], { cwd: root, env: { ...process.env, RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_CODE_CONTROL_DIR: controlDir, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir }, stdio: ["ignore", "ignore", "pipe"] });
  electron.stderr!.on("data", data => { stderr += data; });
  await waitFor("Electron CDP 地址", () => /DevTools listening on ws:\/\/[^:]+:\d+\//.test(stderr), 20_000);
  const port = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(stderr)![1];
  let page: any;
  await waitFor("Electron 页面调试目标", async () => { page = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).find(item => item.type === "page" && item.url.startsWith("file:")); return !!page; }, 20_000);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("message", event => { const value = JSON.parse(String(event.data)); if (value.id) { const entry = pending.get(value.id); if (entry) { pending.delete(value.id); if (value.error) entry.reject(new Error(JSON.stringify(value.error))); else entry.resolve(value.result); } } else if (value.method === "Runtime.exceptionThrown") runtimeMessages.push(value.params); });
  await new Promise<void>((resolve, reject) => { ws!.addEventListener("open", () => resolve(), { once: true }); ws!.addEventListener("error", reject, { once: true }); });
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await waitDom("桌面 Code 在线与会话树", `document.querySelector('.connection')?.textContent?.includes('已连接') && document.querySelector('.session-list .session')!==null`);
  await evaluate(`(()=>{document.querySelector('.session-list .session').click();return true})()`);
  await waitDom("右栏安装", `document.querySelector('.inspector')!==null`);
  assert.equal(await evaluate("typeof require"), "undefined");
  assert.equal(await evaluate("typeof process"), "undefined");
  mark("real Electron connected to temporary Runtime through sandbox preload", { pid: electron.pid, sessionId: session.id });

  if (packaged) {
    save("packaged-startup.json", { launchSource: "app.asar", pageUrl: page.url, dom: await dom(), nodeGlobals: { require: await evaluate("typeof require"), process: await evaluate("typeof process") } });
    await screenshot("packaged-startup-light.png");
    mark("final packaged main, preload and renderer open the workspace through a real temporary Code connection");
    success = true;
  } else {

  const fileTask = await t.runtime.submit({ sessionId: session.id, requestId: "d07-files-1", input: "d07-files：逐项运行真实工具。", modelSelection: t.runtime.defaultSelection, accessMode: "full_access" });
  await waitFor("五项真实 edit/write 结束", () => t.runtime.store.getTask(fileTask.id)?.status === "completed", 60_000);
  await waitDom("五项工具历史显示", `document.querySelectorAll('.canvas .tool-row').length===5 && [...document.querySelectorAll('.canvas .tool-status')].every(x=>!x.textContent.includes('执行中'))`);
  assert.equal(fs.readFileSync(path.join(work, "small.txt"), "utf8"), smallAfter);
  assert.equal(fs.readFileSync(path.join(work, "large.txt"), "utf8"), largeAfter);
  assert.equal(fs.readFileSync(path.join(work, "empty.txt"), "utf8"), "");
  assert.equal(fs.statSync(path.join(work, "blocked")).isDirectory(), true);
  const history = t.runtime.readHistory({ sessionId: session.id });
  const toolHistory = history.entries.filter(entry => entry.role === "toolResult");
  const results = toolHistory.map(entry => ({ entryId: entry.entryId, result: t.runtime.readToolResult({ sessionId: session.id, entryId: entry.entryId, length: 64 * 1024 }) }));
  save("tool-results.json", results);
  assert.equal(results.length, 5);
  assert.equal(results[1].result.truncated, true);
  assert.equal(results[4].result.isError, true);
  assert.equal(results[4].result.writeContent, "never written\n");

  await clickDiff("small.txt");
  let shown = await diffDom();
  assert.ok(shown.patch.some((line: any) => line.kind === "patch-removed" && line.text.includes("before")));
  assert.ok(shown.patch.some((line: any) => line.kind === "patch-added" && line.text.includes("after")));
  save("edit-small.json", shown);
  await screenshot("edit-small-light.png");
  mark("real edit patch rendered with added and removed lines");

  await clickDiff("large.txt");
  shown = await diffDom();
  assert.match(shown.truncated, /截断/);
  assert.ok(shown.patch.length > 100);
  save("edit-truncated.json", { ...shown, patch: shown.patch.slice(0, 8), totalRenderedLines: shown.patch.length });
  await screenshot("edit-truncated-light.png");
  mark("real edit greater than 64 KiB is visibly marked truncated", { renderedLines: shown.patch.length });

  await clickDiff("new.txt");
  shown = await diffDom();
  assert.equal(shown.write, "新文件正文\n中文👩‍💻\n");
  assert.equal(shown.patch.length, 0);
  save("write-new.json", shown);
  await screenshot("write-new-light.png");
  mark("real Write shows the resulting new file content");

  await clickDiff("empty.txt");
  shown = await diffDom();
  assert.match(shown.text, /空文件（0 行）/);
  assert.ok(!shown.text.includes("差异不可用"));
  save("write-empty.json", shown);
  await screenshot("write-empty-light.png");
  mark("real empty Write is shown as an empty file");

  await clickDiff("blocked");
  shown = await diffDom();
  assert.match(shown.header, /失败/);
  assert.ok(!shown.text.includes("never written"));
  assert.equal(shown.write, null);
  assert.equal(shown.patch.length, 0);
  save("write-failed.json", shown);
  await screenshot("write-failed-light.png");
  mark("real failed Write to an existing directory never displays uncommitted call content");

  const parent = await t.runtime.submit({ sessionId: session.id, requestId: "d07-subagent-1", input: "d07-subagent：委派并让子会话等待验收。", modelSelection: t.runtime.defaultSelection, accessMode: "full_access" });
  await waitFor("子任务真实读取后等待模型", () => childHeld, 60_000);
  const workDelegation = t.runtime.store.listWorkDelegationsBySession(session.id)[0];
  assert.ok(workDelegation);
  const agent = t.runtime.store.getSubAgent(workDelegation.subAgentId)!;
  const child = t.runtime.store.listTasksByWork(workDelegation.id)[0];
  assert.equal(t.runtime.store.getTask(child.id)?.status, "running");
  await evaluate(`(()=>{[...document.querySelectorAll('.inspector-tabs button')].find(x=>x.textContent==='SubAgent').click();return true})()`);
  await waitDom("右栏出现 SubAgent", `document.querySelector('.agent-choice')!==null`);
  await evaluate(`(()=>{document.querySelector('.agent-choice').click();return true})()`);
  await waitDom("右栏子会话思考与工具", `document.querySelectorAll('.inspector .thinking').length>=2 && document.querySelectorAll('.inspector .tool-row').length===1`);
  const before = await childDom();
  save("subagent-initial-detail.json", { dom: before, detail: t.runtime.getTaskDetail(child.id) });
  assert.equal(before.tools[0].status, "已完成");
  save("subagent-before-reconnect.json", before);
  await screenshot("subagent-running-light.png");
  await evaluate(`(()=>{globalThis.d07Updates=[];globalThis.ruukoto.subscribe('code',u=>{if(u.type==='snapshot')d07Updates.push({type:u.type,instanceId:u.result.snapshot.instanceId,seq:u.result.seq});});return true})()`);
  const previousSnapshots = await evaluate<number>("d07Updates.length");
  const reconnect = await evaluate(`ruukoto.request('code','reconnect',{})`);
  assert.equal(reconnect.ok, true);
  await waitDom("运行中重连恢复新快照", `d07Updates.length>${previousSnapshots} && document.querySelector('.connection')?.textContent?.includes('已连接') && document.querySelectorAll('.inspector .thinking').length>=2 && document.querySelectorAll('.inspector .tool-row').length===1`);
  const after = await childDom();
  assert.deepEqual(after, before);
  assert.equal(t.runtime.store.getTask(child.id)?.status, "running");
  save("subagent-after-reconnect.json", { ...after, snapshots: await evaluate("d07Updates") });
  await screenshot("subagent-after-reconnect-light.png");
  const childEvents = t.runtime.readTaskEvents({ taskId: child.id, afterSeq: 0, limit: 100 });
  save("subagent-backend.json", { work: workDelegation, agent, parentId: parent.id, childTaskId: child.id, childSessionId: agent.sessionId, task: t.runtime.getTaskDetail(child.id), events: childEvents });
  mark("SubAgent running reconnect preserves thinking, tool identities, messages and counts", { thinking: before.thinking.length, tools: before.tools.length, messages: before.messages.length });
  releaseChild();
  await waitFor("子任务完成", () => t.runtime.store.getTask(child.id)?.status === "completed", 30_000);
  await waitDom("子会话完成正文", `document.querySelector('.inspector .conversation')?.textContent?.includes('子会话最终回答：真实读取完成，没有丢失历史。')`);
  save("subagent-completed.json", await childDom());
  mark("SubAgent final response is installed in the same selected child history");

  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await screenshot("subagent-completed-light.png");
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await screenshot("subagent-completed-dark.png");
  await clickDiff("small.txt");
  await screenshot("edit-small-dark.png");
  save("dark-layout.json", await dom());
  fs.writeFileSync(path.join(evidenceDir, "window-command"), "small");
  await waitDom("最小原生窗口", "innerWidth===760 && innerHeight<=500");
  await screenshot("minimum-window-diff-dark.png");
  save("minimum-window-diff.json", await dom());
  await evaluate(`(()=>{[...document.querySelectorAll('.inspector-tabs button')].find(x=>x.textContent==='SubAgent').click();return true})()`);
  await screenshot("minimum-window-subagent-dark.png");
  save("minimum-window-subagent.json", await dom());
  mark("light and dark schemes plus native 760 by 500 minimum window captured");
  save("runtime-errors.json", runtimeMessages);
  assert.equal(runtimeMessages.length, 0);
  success = true;
  }
} catch (error) {
  save("failure.json", { error: error instanceof Error ? error.stack : String(error), outcomes });
  if (ws?.readyState === WebSocket.OPEN) {
    try { save("failure-dom.json", await dom()); save("failure-child.json", await childDom()); save("failure-backend.json", t.runtime.snapshot()); await screenshot("failure.png"); } catch (captureError) { save("failure-capture.json", String(captureError)); }
  }
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  releaseChild();
  ws?.close();
  if (electron && electron.exitCode === null) {
    fs.writeFileSync(path.join(evidenceDir, "window-command"), "quit");
    for (let index = 0; index < 80 && electron.exitCode === null; index++) await sleep(100);
    if (electron.exitCode === null) electron.kill("SIGTERM");
    for (let index = 0; index < 30 && electron.exitCode === null; index++) await sleep(100);
    if (electron.exitCode === null) electron.kill("SIGKILL");
  }
  await t.shutdown();
  fs.rmSync(controlDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(evidenceDir, "stderr.log"), stderr);
  const built: { path: string; bytes: number; sha256: string }[] = [];
  const visitBuild = (folder: string) => { for (const name of fs.readdirSync(folder)) { const file = path.join(folder, name); if (fs.statSync(file).isDirectory()) visitBuild(file); else built.push({ path: path.relative(root, file), bytes: fs.statSync(file).size, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }); } };
  visitBuild(path.join(root, "apps/desktop/out"));
  save("build-manifest.json", built);
  fs.copyFileSync("/tmp/ruukoto-d07-external.mts", path.join(evidenceDir, "probe.mts"));
  save("verification.json", { success, outcomes, environment: "macOS Apple Silicon; actual Electron, Runtime, ControlServer, preload and real edit/write/read worker tools; deterministic local mock model; native sandbox not tested", cleanup: { electronExitCode: electron?.exitCode, electronPid: electron?.pid, controlDirectoryRemoved: !fs.existsSync(controlDir), runtimeDirectoryRemoved: !fs.existsSync(t.dirs.root) }, finalOutMainSha256: fs.existsSync(path.join(root, "apps/desktop/out/main/index.js")) ? createHash("sha256").update(fs.readFileSync(path.join(root, "apps/desktop/out/main/index.js"))).digest("hex") : null });
  process.stdout.write(`EVIDENCE=${evidenceDir}\n`);
}
