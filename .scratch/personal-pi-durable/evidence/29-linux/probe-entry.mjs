import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-permissions.ts";
import { toolOperations, toolDecide, toolResolve, toolVerifyStop, toolUnresolved } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-tools.ts";
import { readPersonalArtifact } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-artifacts.ts";
import { PersonalCommandDoc } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-command-work.ts";
import { MockModelServer } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT, self = process.argv[1], mode = process.argv[2], base = process.argv[3];
const sha = value => createHash("sha256").update(value).digest("hex");
const read = filename => JSON.parse(fs.readFileSync(filename, "utf8"));
const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 60000) { const end = Date.now() + timeout; while (!await check()) { assert.ok(Date.now() < end, `timeout: ${label}`); await sleep(25); } }
async function bounded(promise, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 60000); })]); } finally { clearTimeout(timer); } }
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function owner(f, restore) {
  const server = new MockModelServer(request => {
    const last = request.messages.at(-1)?.content;
    if (request.system?.includes("你是个人助手的子 Agent")) {
      const calls = last === "读取允许资料" ? [{ id: "read-allowed", name: "read_file", arguments: { path: f.allowed } }]
        : last === "读取保护资料" ? [{ id: "read-protected", name: "read_file", arguments: { path: path.join(f.profile, "profile.json") } }]
        : last === "读取未授权资料" ? [{ id: "read-outside", name: "read_file", arguments: { path: f.outside } }]
        : last === "执行HTTP写入" ? [{ id: "original-write", name: "http_request", arguments: { method: "POST", url: f.url, body: "original-write" } }]
        : last === "执行隔离对照" ? [{ id: "restricted-command", name: "run_command", arguments: { command: f.command } }] : undefined;
      if (calls) return { kind: "tool_calls", calls };
    }
    return { kind: "text", text: "完成" };
  });
  const model = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RK29_SYNTHETIC_MODEL_KEY", contextWindow: 128000, maxTokens: 1024 };
  process.env[model.apiKeyEnv] = "test-only";
  let p;
  try {
    p = await openPersonalHarness({ directory: f.profile, tools: f.config, ...(f.commands ? { commands: f.commands } : {}), provider: personalProvider(model), modelId: model.modelId });
    const operations = () => p.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))), context);
    if (!restore) await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = f.permission; }, context);
    if (f.name === "http-crash") {
      let work;
      if (!restore) {
        await p.answer("拥有者明确要求执行测试HTTP写入", "original-source");
        work = await p.work.delegate({ requestId: "original-work", sourceRequestId: "original-source", content: "执行HTTP写入" });
        write(path.join(f.root, "work.json"), work);
        await until(async () => { const op = (await operations())[0]; if (!op?.started) return false; write(path.join(f.root, "operation-before-kill.json"), op); return true; }, "persisted HTTP start");
        await until(() => false, "parent kills owner after external write", 120000);
      } else {
        work = read(path.join(f.root, "work.json"));
        await until(async () => { const op = (await operations())[0]; return op?.effect === "effect_unknown" && op.code !== "started"; }, "original HTTP recovery");
        let op = (await operations())[0];
        assert.equal(op.operation, read(path.join(f.root, "operation-before-kill.json")).operation); assert.equal(op.stopped, false); assert.equal(toolUnresolved(op), true);
        assert.deepEqual((await p.work.list()).find(agent => agent.id === work.agentId).work, work);
        await assert.rejects(p.work.delegate({ requestId: "forbidden-retry", sourceRequestId: "original-source", content: "换一种方式重试" }));
        assert.equal(await p.answer("独立聊天继续", "independent-source"), "完成");
        write(path.join(f.root, "restore-paused.json"), { operation: op, agents: await p.work.list(), modelCalls: server.calls });
        await p.harness.commit(tx => toolResolve(tx, op.operation, "applied", "独立核对专属HTTP服务外部账本，原写入仅执行一次。"), context);
        op = (await operations())[0]; assert.equal(op.stopped, false); assert.equal(toolUnresolved(op), true);
        assert.deepEqual((await p.work.list()).find(agent => agent.id === work.agentId).work, work);
        write(path.join(f.root, "effect-resolved.json"), { operation: op, agents: await p.work.list() });
        await until(() => fs.existsSync(path.join(f.root, "remote-ended.json")), "independent server request ended proof");
        await p.harness.commit(tx => toolVerifyStop(tx, op.operation, "服务侧独立控制器已终止原待完成请求，确认无活动业务处理。"), context);
        const settled = await bounded(p.harness.waitForTask(work.taskId, context), "original work releases");
        assert.ok(["completed", "failed"].includes(settled.state.outcome.status));
        if (settled.state.outcome.status === "failed") assert.match(settled.state.outcome.error.message, /子会话未完成回答/);
        op = (await operations())[0]; assert.equal(toolUnresolved(op), false); assert.equal(op.stopped, true);
        assert.equal((await p.work.list()).find(agent => agent.id === work.agentId).work, undefined);
        const reused = await p.work.delegate({ requestId: "reused-after-proof", sourceRequestId: "independent-source", agentId: work.agentId, content: "只分析，不执行操作" });
        await bounded(p.harness.waitForTask(reused.taskId, context), "identity reused"); assert.equal(reused.agentId, work.agentId);
        write(path.join(f.root, "result.json"), { work, operation: op, settled, reused, modelCalls: server.calls });
      }
    } else if (f.name === "files") {
      await p.answer("请核对资料读取范围与保护边界", "file-source");
      const run = async (content, requestId) => { const work = await p.work.delegate({ requestId, sourceRequestId: "file-source", content }); await bounded(p.harness.waitForTask(work.taskId, context), requestId); return work; };
      await run("读取允许资料", "allowed-file");
      const allowed = (await operations())[0]; assert.equal(allowed.code, "file_returned"); assert.equal(allowed.effect, "returned"); assert.ok(allowed.artifact);
      const page = await readPersonalArtifact(f.profile, allowed.artifact); assert.deepEqual(Buffer.from(page.base64, "base64"), fs.readFileSync(f.allowed));
      await run("读取保护资料", "protected-file"); assert.equal((await operations()).length, 1); assert.match(JSON.stringify(server.calls), /file_target_invalid/);
      const outside = await p.work.delegate({ requestId: "outside-file", sourceRequestId: "file-source", content: "读取未授权资料" });
      await until(async () => (await operations()).length === 2, "outside file waits for owner");
      const pending = (await operations())[1]; assert.equal(pending.started, false); assert.equal(pending.approval, "pending"); assert.equal(pending.artifact, undefined);
      await p.harness.commit(tx => toolDecide(tx, pending.operation, "rejected", f.profile), context);
      await bounded(p.harness.waitForTask(outside.taskId, context), "outside read rejected");
      write(path.join(f.root, "result.json"), { operations: await operations(), modelCalls: server.calls, allowedBytes: page.bytes, allowedSha256: allowed.artifact.sha256 });
    } else {
      await p.answer("核实受限命令与通用工具组合的文件和网络隔离", "command-source");
      const work = await p.work.delegate({ requestId: "restricted-original", sourceRequestId: "command-source", content: "执行隔离对照" });
      await bounded(p.harness.waitForTask(work.taskId, context), "restricted command completes");
      const item = (await p.commands.list()).items[0], op = (await p.harness.snapshot(PersonalCommandDoc, item.ref.requestId, context)).command;
      assert.equal(op.prepared.spec.mode, f.permission); assert.equal(op.stopped, true); assert.equal(op.result.effect, "returned"); assert.equal(op.result.exitCode, 0);
      const facts = read(path.join(f.workspace, "facts.json")); assert.deepEqual(facts, { readDenied: true, writeDenied: true, networkDenied: true });
      write(path.join(f.root, "result.json"), { work, operation: op, facts, modelCalls: server.calls });
    }
  } finally { await p?.close(); await server.close(); }
}

if (mode === "owner" || mode === "restore") await owner(read(process.argv[4]), mode === "restore");
else {
  const evidence = path.join(base, "evidence"), fixtures = path.join(base, "fixtures"); fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); fs.mkdirSync(fixtures, { recursive: true, mode: 0o700 });
  write(path.join(evidence, "environment.json"), { timestamp: new Date().toISOString(), platform: process.platform, arch: process.arch, uid: process.getuid(), node: process.version, kernel: execFileSync("uname", ["-a"], { encoding: "utf8" }).trim(), bwrap: execFileSync("bwrap", ["--version"], { encoding: "utf8" }).trim(), manager: execFileSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).trim(), probeSha256: sha(fs.readFileSync(self)), noOSMock: true, provider: "HTTP/SSE replacement model", remoteService: "dedicated local HTTP fixture" });
  let writes = 0, networkReads = 0; const active = new Set();
  const remote = createServer((req, res) => { if (req.method === "POST") { writes++; active.add(res); fs.writeFileSync(path.join(evidence, "http-count"), String(writes)); res.write("external-write-started"); } else { networkReads++; res.end("unexpected-command-network-access"); } });
  await new Promise(resolve => remote.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${remote.address().port}/write`;
  const children = [], results = [];
  const launch = (f, childMode) => { const child = spawn(process.execPath, [self, childMode, base, f.inputFile], { stdio: ["ignore", fs.openSync(path.join(f.root, childMode + ".stdout"), "a"), fs.openSync(path.join(f.root, childMode + ".stderr"), "a")] }); children.push(child); child.finished = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal }))); return child; };
  try {
    for (const name of ["files", "http-crash", "restricted-confirm", "restricted-auto-review"]) {
      const root = fs.mkdtempSync(path.join(fixtures, name + "-")), profile = path.join(root, "profile"), workspace = path.join(root, "work"), allowed = path.join(workspace, "allowed.bin"), outside = path.join(root, "outside.bin"); fs.mkdirSync(workspace, { mode: 0o700 });
      fs.writeFileSync(allowed, Buffer.from([0, 255, 128, 10, 99])); fs.writeFileSync(outside, "outside-original");
      const stat = fs.statSync(workspace), config = { version: 1, generation: randomUUID(), workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] }, permission = name === "http-crash" ? "full_access" : name === "restricted-auto-review" ? "auto-review" : "confirm";
      const code = `const fs=require('node:fs'),http=require('node:http');let readDenied=false,writeDenied=false;try{fs.readFileSync(${JSON.stringify(outside)})}catch{readDenied=true}try{fs.writeFileSync(${JSON.stringify(path.join(root, "outside-written"))},'x')}catch{writeDenied=true}const done=networkDenied=>fs.writeFileSync('facts.json',JSON.stringify({readDenied,writeDenied,networkDenied}));http.get(${JSON.stringify(url)},r=>{r.resume();r.on('end',()=>done(false))}).on('error',()=>done(true));`;
      const f = { name, root, profile, workspace, allowed, outside, config, permission, url, ...(name.startsWith("restricted-") ? { commands: { version: 1, workspace, identity: config.identity, machineId: fs.readFileSync("/etc/machine-id", "utf8").trim(), tmpdir: fs.realpathSync(os.tmpdir()) }, command: `/usr/local/bin/node -e ${shellQuote(code)}` } : {}), inputFile: path.join(root, "fixture.json") }; write(f.inputFile, f);
      const child = launch(f, "owner");
      if (name === "http-crash") {
        await until(() => writes === 1 && fs.existsSync(path.join(root, "operation-before-kill.json")), "external write before owner SIGKILL");
        child.kill("SIGKILL"); assert.equal((await bounded(child.finished, "owner killed")).signal, "SIGKILL");
        execFileSync("tar", ["-czf", path.join(evidence, "profile-after-owner-kill.tar.gz"), "-C", root, "profile"]);
        const restored = launch(f, "restore");
        await until(() => fs.existsSync(path.join(root, "effect-resolved.json")), "effect alone keeps ownership"); assert.equal(writes, 1);
        for (const response of active) response.end("remote-operation-ended"); active.clear();
        write(path.join(root, "remote-ended.json"), { ended: true, writes });
        const exit = await bounded(restored.finished, "restore finished"); assert.equal(exit.code, 0, fs.readFileSync(path.join(root, "restore.stderr"), "utf8")); assert.equal(writes, 1);
      } else { const exit = await bounded(child.finished, name); assert.equal(exit.code, 0, fs.readFileSync(path.join(root, "owner.stderr"), "utf8")); }
      results.push({ name, root, result: read(path.join(root, "result.json")) });
    }
    assert.equal(networkReads, 0); assert.equal(writes, 1);
    write(path.join(evidence, "summary.json"), { results, externalWrites: writes, forbiddenCommandNetworkReads: networkReads });
    process.stdout.write(JSON.stringify({ scenarios: results.map(value => value.name), externalWrites: writes, forbiddenCommandNetworkReads: networkReads }) + "\n");
  } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); }
}
