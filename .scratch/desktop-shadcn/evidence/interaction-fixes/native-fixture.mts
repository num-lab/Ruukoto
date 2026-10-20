import * as fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

const repository = process.env.RUUKOTO_QA_ROOT;
const evidenceDirectory = process.env.RUUKOTO_QA_EVIDENCE;
if (!repository || !path.isAbsolute(repository) || !evidenceDirectory || !path.isAbsolute(evidenceDirectory)) throw new Error("设置绝对路径 RUUKOTO_QA_ROOT 和 RUUKOTO_QA_EVIDENCE 后运行隔离验收。");
const root = path.resolve(repository), evidence = path.resolve(evidenceDirectory);
fs.mkdirSync(evidence, { recursive: true });
const { startTestRuntime, lastUserText, afterTool, realTools, waitFor } = await import(pathToFileURL(path.join(root, "test/helpers/testkit.ts")).href);
const { product: codeProduct } = await import(pathToFileURL(path.join(root, "apps/ruukoto-code/src/product.ts")).href);
const { product: personalProduct } = await import(pathToFileURL(path.join(root, "apps/ruukoto/src/product.ts")).href);
const { savePersonalConfig } = await import(pathToFileURL(path.join(root, "apps/desktop/src/main/personal-config.ts")).href);
const temporary = fs.mkdtempSync("/tmp/rmg-issue20-");
const profile = path.join(temporary, "profile"), control = path.join(temporary, "control"), sshDirectory = path.join(temporary, "bin"), sshLog = path.join(temporary, "ssh-children.jsonl");
for (const directory of [profile, control, sshDirectory]) fs.mkdirSync(directory, { mode: 0o700 });
let child: ChildProcess | undefined;
let stopRequested = false;
let appExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
const stop = () => { stopRequested = true; if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const runtimes: { target: "code" | "personal"; fixture: Awaited<ReturnType<typeof startTestRuntime>> }[] = [];
const writeJson = (name: string, value: unknown) => fs.writeFileSync(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`);
const gitEnvironment = { ...process.env };
for (const key of Object.keys(gitEnvironment)) if (key.startsWith("GIT_")) delete gitEnvironment[key];
Object.assign(gitEnvironment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_OPTIONAL_LOCKS: "0" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: gitEnvironment, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 }).trim();

try {
  const readSource = path.join(temporary, "captured-outside-workspace.ts");
  const readSourceText = [
    "// 此内容经真实 Read worker 捕获；验收前源文件已删除。",
    "export interface Journey { origin: string; destination: string; cached: boolean }",
    "export const journey: Journey = { origin: 'Tokyo', destination: 'Kyoto', cached: true };",
    "export function label(value: Journey): string { return `${value.origin} → ${value.destination}`; }",
    "",
  ].join("\n");
  fs.writeFileSync(readSource, readSourceText);
  const longMarkdown = (index: number) => [
    `# 滚动验收消息 ${String(index).padStart(2, "0")}`,
    "这是隔离后台通过本地确定性 MockModelServer 生成的长 Markdown 消息，用来观察已加载消息快速滚动时的实际绘制，不调用真实模型。",
    ...Array.from({ length: 5 }, (_, section) => [
      `## ${index}.${section + 1} 缓存与重连检查`,
      "消息流应保持正文、代码块、列表及表格的布局。快速向上或向下滚动时，已加载内容应及时绘制；回到当前位置后，文件链接与工具行仍应能操作。",
      "- 离线状态保留已缓存车票。\n- 重连按记录的时间戳合并。\n- 展开详情不改变消息所属会话。",
      "```typescript\ninterface CacheEntry { id: string; updatedAt: number }\nconst merge = (old: CacheEntry, next: CacheEntry) => next.updatedAt >= old.updatedAt ? next : old;\nexport const cached = { id: 'tokyo-kyoto', updatedAt: 1720000000 };\n```",
      "| 检查点 | 预期 |\n| --- | --- |\n| 已加载正文 | 无延迟空白 |\n| 文件树刷新 | 新增与删除可见 |\n| Read 捕获 | 源文件删除后可预览 |",
      "> 此处是滚动验收用的引用块。**粗体**、*斜体*与 `inlineCode` 会在同一条消息中出现。",
    ].join("\n\n")),
    `消息 ${index} 结束。`,
  ].join("\n\n");
  const code = await startTestRuntime("mygo-issue20-code", async request => {
    const input = lastUserText(request);
    if (input.startsWith("QA_READ_CAPTURE:")) {
      if (!afterTool(request)) return { kind: "tool_calls", calls: [{ id: "qa-outside-read", name: "read", arguments: { path: readSource } }] };
      return { kind: "text", text: `已通过真实 Read 工具读取并捕获 \`${readSource}\`。验收脚本会在捕获后删除源文件，点击上面的 Read 文件路径应打开捕获时的版本。` };
    }
    const match = input.match(/^QA_SCROLL_(\d+):/);
    return { kind: "text", text: match ? longMarkdown(Number(match[1])) : `Code 回显：${input}\n\n这是隔离 Code 后台的真实任务结果。` };
  }, { config: { product: codeProduct.runtime, ...realTools() } });
  runtimes.push({ target: "code", fixture: code });
  const personal = await startTestRuntime("mygo-v4-pa", async request => ({ kind: "text", text: `PA 回显：${lastUserText(request)}\n\n这是隔离个人 Agent 主会话的真实任务结果。` }), { config: { product: personalProduct.runtime } });
  runtimes.push({ target: "personal", fixture: personal });
  fs.symlinkSync(path.join(code.runtime.controlDir(), "owner.token"), path.join(control, "owner.token"));
  fs.symlinkSync(code.runtime.socketPath(), path.join(control, "control.sock"));
  const workspace = path.join(code.work[0], "git-workspace"), nonrepo = path.join(code.work[1], "ordinary-workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true }); fs.mkdirSync(nonrepo);
  fs.writeFileSync(path.join(workspace, "README.md"), "# 隔离 Git 工作区\n\n用于 Git graph、文件树与 Markdown 预览验收。\n");
  fs.writeFileSync(path.join(workspace, "src", "index.ts"), "export const route = 'Tokyo → Kyoto';\n");
  fs.writeFileSync(path.join(workspace, "sample.txt"), "隔离附件选择与快照上传验收\n");
  fs.writeFileSync(path.join(nonrepo, "README.md"), "# 普通目录\n\n此目录不属于 Git 仓库，不能出现 Git graph 入口。\n");
  git(workspace, "init", "-b", "main"); git(workspace, "config", "user.name", "Desktop QA"); git(workspace, "config", "user.email", "desktop-qa@example.invalid");
  git(workspace, "add", "."); git(workspace, "commit", "-m", "建立行程预览与验收文件");
  git(workspace, "switch", "-c", "feature/offline-cache");
  fs.writeFileSync(path.join(workspace, "src", "offline.ts"), "export const cached = true;\n");
  git(workspace, "add", "."); git(workspace, "commit", "-m", "增加离线缓存读取"); git(workspace, "tag", "v0.1.0");
  git(workspace, "switch", "main");
  fs.appendFileSync(path.join(workspace, "src", "index.ts"), "export const timezone = 'Asia/Tokyo';\n");
  git(workspace, "add", "."); git(workspace, "commit", "-m", "统一行程时区显示");
  git(workspace, "merge", "--no-ff", "feature/offline-cache", "-m", "合并离线缓存支持");
  git(workspace, "update-ref", "refs/remotes/origin/main", "HEAD^1");
  const opened = await code.runtime.openWorkspace({ cwd: workspace });
  const second = await code.runtime.createSession({ projectId: opened.session.projectId, cwd: workspace });
  const ordinary = await code.runtime.openWorkspace({ cwd: nonrepo });
  const mainId = personal.runtime.snapshot().mainSessionId;
  if (!mainId) throw new Error("隔离 PA 后台没有主会话，停止验收。");
  const paSession = personal.runtime.store.getSession(mainId);
  await personal.runtime.setSessionModel({ sessionId: mainId, modelSelection: personal.runtime.defaultSelection, expectedVersion: paSession.modelSelectionVersion });
  const initial = [
    { target: "code", fixture: code, sessionId: opened.session.id, input: "检查离线缓存的 Git 提交" },
    { target: "code", fixture: code, sessionId: second.id, input: "第二个 Code 会话，用于标签拖动" },
    { target: "code", fixture: code, sessionId: ordinary.session.id, input: "普通目录会话，没有 Git graph" },
    { target: "personal", fixture: personal, sessionId: mainId, input: "你好，Ruukoto。" },
  ];
  for (const item of initial) {
    const task = await item.fixture.runtime.submit({ sessionId: item.sessionId, requestId: crypto.randomUUID(), input: item.input, modelSelection: item.fixture.runtime.defaultSelection });
    await waitFor(`初始化 ${item.target} 会话`, () => item.fixture.runtime.store.getTask(task.id)?.status === "completed");
  }
  const seededTasks: { index: number; taskId: string; bytes: number }[] = [];
  for (let index = 1; index <= 40; index++) {
    if (stopRequested) throw new Error("隔离验收已取消。");
    const task = await code.runtime.submit({ sessionId: opened.session.id, requestId: crypto.randomUUID(), input: `QA_SCROLL_${index}: 展示第 ${index} 条长 Markdown 滚动样本`, modelSelection: code.runtime.defaultSelection, accessMode: "full_access" });
    await waitFor(`初始化长消息 ${index}/40`, () => ["completed", "failed", "canceled"].includes(code.runtime.store.getTask(task.id)?.status ?? ""), 60_000);
    assert.equal(code.runtime.store.getTask(task.id)?.status, "completed");
    const reply = code.runtime.readTaskReplyText(task.id);
    assert.equal(reply, longMarkdown(index));
    seededTasks.push({ index, taskId: task.id, bytes: Buffer.byteLength(reply!) });
  }
  process.stdout.write(`已准备 ${seededTasks.length} 条长 Markdown，开始真实 worker Read 捕获。\n`);
  const readTask = await code.runtime.submit({ sessionId: opened.session.id, requestId: crypto.randomUUID(), input: `QA_READ_CAPTURE: 读取 ${readSource}，用于捕获快照预览验收`, modelSelection: code.runtime.defaultSelection, accessMode: "full_access" });
  await waitFor("真实 Read 完成", () => ["completed", "failed", "canceled"].includes(code.runtime.store.getTask(readTask.id)?.status ?? ""), 60_000);
  const readDetail = code.runtime.getTaskDetail(readTask.id);
  assert.equal(readDetail?.task.status, "completed");
  assert.equal(readDetail!.toolOps.length, 1);
  const operation = readDetail!.toolOps[0]!;
  assert.equal(operation.toolName, "read"); assert.equal(operation.params.path, readSource);
  assert.equal(operation.isError, false); assert.equal(operation.effectUnknown, false); assert.ok(operation.recordedResultAt);
  const events = code.runtime.readTaskEvents({ taskId: readTask.id, limit: 500 }).events;
  const results = events.filter(event => event.body.type === "task.tool_result" && event.body.toolOpId === operation.id);
  assert.equal(results.length, 1);
  const result = results[0]!.body;
  assert.ok(result.type === "task.tool_result"); assert.equal(result.isError, false); assert.equal(result.artifactIds.length, 1);
  const artifactId = result.artifactIds[0]!;
  const readParams = { task_id: readTask.id, session_id: opened.session.id, artifact_id: artifactId, offset: 0, length: 256 * 1024 };
  const captured = await code.client.request("read_artifact", readParams);
  assert.equal(captured.artifact.id, artifactId); assert.equal(captured.artifact.taskId, readTask.id); assert.equal(captured.artifact.sessionId, opened.session.id);
  assert.equal(captured.artifact.status, "complete"); assert.equal(captured.artifact.byteCount, Buffer.byteLength(readSourceText));
  assert.equal(captured.encoding, "base64"); assert.equal(Buffer.from(captured.data, "base64").toString("utf8"), readSourceText);
  fs.unlinkSync(readSource);
  const afterDeletion = await code.client.request("read_artifact", readParams);
  assert.equal(afterDeletion.data, captured.data); assert.equal(fs.existsSync(readSource), false);
  const toolEntry = code.runtime.readHistory({ sessionId: opened.session.id, limit: 20 }).entries.find(entry => entry.taskId === readTask.id && entry.role === "toolResult" && entry.toolName === "read");
  assert.ok(toolEntry);
  const readCapture = { source: readSource, sourceRemoved: true, capturedBytes: Buffer.byteLength(readSourceText), sha256: createHash("sha256").update(readSourceText).digest("hex"), sessionId: opened.session.id, taskId: readTask.id, toolOpId: operation.id, sdkCallId: operation.sdkCallId, entryId: toolEntry!.entryId, canonicalTool: operation.toolName, resultIsError: operation.isError, artifactIds: result.artifactIds, artifact: captured.artifact, streamContract: "成功 canonical read 的唯一捕获流是 file_read；不通过产物名称识别", readAfterSourceDeletion: true };
  writeJson("read-capture.json", readCapture);
  writeJson("scroll-fixture.json", { assistantLongMarkdownCount: seededTasks.length, assistantLongMarkdownBytes: seededTasks.reduce((sum, task) => sum + task.bytes, 0), tasks: seededTasks });
  const workspaceMutation = { rootFile: path.join(workspace, "qa-live-added.ts"), expandedFolder: path.join(workspace, "src"), nestedFile: path.join(workspace, "src", "qa-live-nested.ts"), marker: path.join(workspace, ".ruukoto-qa-owner.json") };
  fs.writeFileSync(workspaceMutation.marker, `${JSON.stringify({ fixturePid: process.pid, workspace, purpose: "issue20-live-files" })}\n`, { mode: 0o600 });
  const gitState = await code.client.request("read_workspace_git", { workspace_id: opened.session.projectId });
  const ordinaryState = await code.client.request("read_workspace_git", { workspace_id: ordinary.session.projectId });
  if (!gitState.repository || gitState.repository.commits.length !== 4 || ordinaryState.repository !== null) throw new Error("隔离 Git 数据不符合预期，停止验收。");
  writeJson("git-fixture.json", { git: gitState, ordinary: ordinaryState });
  const sshExecutable = path.join(sshDirectory, "ssh");
  fs.writeFileSync(sshExecutable, `#!${process.execPath}
const fs = require('node:fs'), net = require('node:net');
const args = process.argv.slice(2), reading = !args.includes('-N');
fs.appendFileSync(process.env.RUUKOTO_QA_SSH_LOG, JSON.stringify({ pid: process.pid, reading, at: Date.now() }) + '\\n');
if (reading) process.stdout.write(fs.readFileSync(process.env.RUUKOTO_QA_PA_TOKEN_FILE));
else {
 const local = args[args.indexOf('-L') + 1].split(':')[0];
 fs.rmSync(local, { force: true });
 net.createServer(client => {
  const remote = net.connect(process.env.RUUKOTO_QA_PA_SOCKET);
  client.pipe(remote); remote.pipe(client);
  client.on('error', () => remote.destroy()); remote.on('error', () => client.destroy());
  client.on('close', () => remote.destroy()); remote.on('close', () => client.destroy());
 }).listen(local);
}
`, { mode: 0o700 });
  savePersonalConfig(profile, { host: "isolated-desktop-pa", controlDir: "/var/lib/ruukoto/control" });
  const executable = process.env.RUUKOTO_QA_EXECUTABLE ?? path.join(root, "dist/mygo/darwin-arm64/Ruukoto MyGo.app/Contents/MacOS/Ruukoto MyGo");
  const metadata = { pid: null as number | null, fixturePid: process.pid, executable, profile, control, workspace, workspaceId: opened.session.projectId, sessionId: opened.session.id, codeSessionIds: [opened.session.id, second.id], nonrepo, nonrepoWorkspaceId: ordinary.session.projectId, nonrepoSessionId: ordinary.session.id, personalMainSessionId: mainId, personalInstanceId: personal.runtime.snapshot().instanceId, codeInstanceId: code.runtime.snapshot().instanceId, sshExecutable, sshLog, sampleFile: path.join(workspace, "sample.txt"), workspaceMutation, readCapture, longMarkdownCount: seededTasks.length, runtime: "真实临时 Code 与 PA Runtime / ControlServer", model: "本地确定性 MockModelServer", ssh: "临时 SSH 替身：仅转发本机隔离 Unix socket 与读取隔离 token，不连接真实服务器", preparedOnly: process.env.RUUKOTO_QA_PREPARE_ONLY === "1" };
  const desktopEnvironment = { ...process.env, PATH: `${sshDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`, RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_DESKTOP_MYGO_USER_DATA: profile, RUUKOTO_CODE_CONTROL_DIR: control, RUUKOTO_CODE_DATA_DIR: code.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: code.dirs.agentDir, RUUKOTO_QA_SSH_LOG: sshLog, RUUKOTO_QA_PA_SOCKET: personal.runtime.socketPath(), RUUKOTO_QA_PA_TOKEN_FILE: path.join(personal.runtime.controlDir(), "owner.token") };
  if (stopRequested) throw new Error("隔离验收已取消。");
  if (metadata.preparedOnly) {
    const { PersonalController } = await import(pathToFileURL(path.join(root, "apps/desktop/src/main/personal-controller.ts")).href);
    const connection = new PersonalController({ host: "isolated-desktop-pa", controlDir: "/var/lib/ruukoto/control" }, profile, () => {}, desktopEnvironment);
    try {
      await connection.reconnect(); await waitFor("SSH 替身认证到隔离 PA", () => connection.status.state === "online");
      const history = await connection.request("read_history", { session_id: mainId });
      if (!history.entries.length) throw new Error("隔离 PA 历史未通过 SSH 替身返回。");
    } finally { await connection.close(); }
  } else {
    fs.accessSync(executable, fs.constants.X_OK);
    child = spawn(executable, [], { cwd: root, env: desktopEnvironment, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", data => fs.appendFileSync(path.join(evidence, "mygo-stderr.log"), data));
    await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
    metadata.pid = child.pid ?? null;
  }
  writeJson("ready.json", metadata);
  process.stdout.write(`MyGo issue20 fixture ready: ${JSON.stringify(metadata)}\n`);
  if (child) {
    if (child.exitCode !== null || child.signalCode !== null) appExit = { code: child.exitCode, signal: child.signalCode };
    else await new Promise<void>(resolve => child!.once("exit", (code, signal) => { appExit = { code, signal }; resolve(); }));
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  writeJson("tasks.json", Object.fromEntries(runtimes.map(({ target, fixture }) => [target, Object.fromEntries(fixture.runtime.snapshot().sessions.map(session => [session.id, fixture.runtime.store.listTasksBySession(session.id)]))])));
  const sshChildren = fs.existsSync(sshLog) ? fs.readFileSync(sshLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  writeJson("ssh-children.json", sshChildren);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw error; } };
  const deadline = Date.now() + 5000;
  while (sshChildren.some(child => alive(child.pid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const remainingSshPids = sshChildren.filter(child => alive(child.pid)).map(child => child.pid);
  const stopped = await Promise.allSettled(runtimes.map(({ fixture }) => fixture.shutdown()));
  const errors = stopped.flatMap((result, index) => result.status === "rejected" ? [{ target: runtimes[index].target, message: String(result.reason) }] : []);
  if (!remainingSshPids.length) fs.rmSync(temporary, { recursive: true, force: true });
  writeJson("cleanup.json", { appExit, remainingSshPids, canceled: stopRequested, temporaryRemoved: !fs.existsSync(temporary), runtimeErrors: errors, finishedAt: new Date().toISOString() });
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  if (errors.length || remainingSshPids.length) process.exitCode = 1;
}
