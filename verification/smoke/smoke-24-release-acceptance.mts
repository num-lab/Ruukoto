/**
 * 两个独立门禁：显式模型配置的原生编码/TUI 退出后继续，或 mock 模型的双产品升级。
 * --upgrade-only 使用 SMOKE24_BASE（默认 8bccb8f）；无 Git 历史时显式提供 SMOKE24_BASE_TAR。
 * 模型配置只复制指定 provider/model；不连接真实 IM，不读取日常实例数据库。
 * 升级部分使用模拟模型，后台进程、独立安装、控制面和持久历史均为真实。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ControlClient } from "@ruukoto/control/client.ts";
import { probeLockHolder } from "@ruukoto/core/instance-lock.ts";
import { PROTOCOL_VERSION } from "@ruukoto/core/types.ts";
import { saveDefaultModel } from "@ruukoto/agent/model-config.ts";
import { authenticateClient, lastUserText, taskStatus, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
import { MockModelServer } from "../../test/helpers/mock-provider.ts";
import { initGitRepo } from "../../test/helpers/git-fixture.ts";
import { prerequisite } from "./gate.ts";

const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const usage = "用法：--upgrade-only | --models <models.json> --model <provider/model>；--help 查看前提";
let options: { "upgrade-only"?: boolean; models?: string; model?: string; help?: boolean };
try {
  options = parseArgs({ options: {
    "upgrade-only": { type: "boolean" }, models: { type: "string" }, model: { type: "string" }, help: { type: "boolean" },
  }, allowPositionals: false, strict: true }).values;
} catch (err) {
  prerequisite(`参数无效：${(err as Error).message}\n${usage}`);
}
if (options.help) {
  process.stdout.write(`${usage}\n升级：需要 npm、tar，以及包含 ruukoto/ruukoto-code 且控制面协议相同的 Git 基点或显式 archive；默认基点 8bccb8f。\n模型：需要构建后的原生执行入口、Python 3 pty，以及显式配置的 provider/model；会调用真实模型，可能产生费用。\n两个入口各自使用临时档案，不读取日常数据库或自动发现凭据。退出码：0 通过，1 失败，2 前提缺失。` + "\n");
  process.exit(0);
}
if (options["upgrade-only"] && (options.models || options.model)) prerequisite(`--upgrade-only 不能与模型参数同用\n${usage}`);
const base = process.env.SMOKE24_BASE ?? "8bccb8f";
const baseTar = process.env.SMOKE24_BASE_TAR;
let providerId = "", modelId = "", provider: any;
if (options["upgrade-only"]) {
  try {
    execFileSync("npm", ["--version"], { stdio: "ignore", timeout: 15_000 });
    execFileSync("tar", ["--version"], { stdio: "ignore", timeout: 15_000 });
    if (baseTar) {
      const entries = execFileSync("tar", ["-tf", baseTar], { encoding: "utf8", timeout: 15_000 }).split("\n");
      for (const product of ["ruukoto", "ruukoto-code"]) {
        if (!entries.includes(`bin/${product}.mjs`) && !entries.includes(`apps/${product}/bin/${product}.mjs`)) throw new Error("archive 缺少当前双产品入口");
      }
    } else {
      const oldPackage = JSON.parse(execFileSync("git", ["show", `${base}:package.json`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }));
      if (!oldPackage.bin?.["ruukoto-code"] || !oldPackage.bin?.ruukoto) throw new Error("基点缺少当前双产品身份");
    }
  } catch {
    prerequisite(`升级需要 npm、tar，以及包含当前 ruukoto/ruukoto-code 入口的基点 ${base} 或 SMOKE24_BASE_TAR；旧 ruukoto-dev 身份不属于此门禁`);
  }
} else {
  if (!options.models || !options.model) prerequisite(`真实模型验收必须显式提供 --models 与 --model\n${usage}`);
  const separator = options.model.indexOf("/");
  if (separator <= 0 || separator === options.model.length - 1) prerequisite("--model 必须为 provider/model");
  providerId = options.model.slice(0, separator);
  modelId = options.model.slice(separator + 1);
  let config: any;
  try { config = JSON.parse(fs.readFileSync(options.models, "utf8")); }
  catch { prerequisite("无法读取指定的 models.json，或文件不是合法 JSON"); }
  provider = config?.providers?.[providerId];
  if (!provider || !Array.isArray(provider.models) || !provider.models.some((m: any) => m?.id === modelId)) {
    prerequisite(`指定配置中没有模型 ${options.model}`);
  }
  try { execFileSync("python3", ["-c", "import pty"], { stdio: "ignore", timeout: 15_000 }); }
  catch { prerequisite("真实模型 TUI 验收需要 Python 3 与 pty 模块"); }
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk24-")));
const children: ChildProcess[] = [];
const clients: ControlClient[] = [];
const controls = new Map<string, string>();
const retainedTasks = new Map<string, string>();
let passed = 0;
let failureCode = 1;
const model = new MockModelServer(req => {
  const last = req.messages.at(-1);
  const input = lastUserText(req);
  if (typeof input === "string" && last?.role !== "tool") {
    if (input.includes("UPGRADE-COPY-WRITE")) return { kind: "tool_calls", calls: [{ id: "preserve-write", name: "write", arguments: { path: "preserved-copy.txt", content: "copy-before-upgrade\n" } }] };
    if (input.includes("preserve-copy")) return { kind: "tool_calls", calls: [{ id: "preserve-delegate", name: "subagent_delegate", arguments: { key: "preserved-copy", request: "UPGRADE-COPY-WRITE", mode: "modify", target: "." } }] };
    if (input.includes("preserve-approval")) return { kind: "tool_calls", calls: [{ id: "preserve-read", name: "request_file_access", arguments: { path: path.join(root, "upgrade-approved.txt"), operation: "read", reason: "升级前批准的资料" } }] };
  }
  if (typeof input === "string" && input.includes("after-upgrade") && last?.role !== "tool") {
    return { kind: "tool_calls", calls: [{ id: "upgrade-native", name: "bash", arguments: { command: "node -e 'require(\"node:fs\").writeFileSync(\"upgraded-native.txt\",\"native\\n\")'" } }] };
  }
  return { kind: "text", text: "独立运行完成" };
});
function workModelCalls(workId: string): number {
  return model.calls.filter(call => {
    const input = lastUserText(call);
    return input.startsWith("[SubAgent 委派") && input.includes(workId);
  }).length;
}

function profile(name: string, product: "ruukoto" | "ruukoto-code") {
  const dir = path.join(root, name);
  const dataDir = path.join(dir, "data"), agentDir = path.join(dir, "agent"), controlDir = path.join(dir, "control");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  controls.set(controlDir, path.join(dataDir, "runtime.lock"));
  const prefix = product === "ruukoto" ? "RUUKOTO" : "RUUKOTO_CODE";
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm-256color",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    RUUKOTO_DISABLE_QQ: "1", RUUKOTO_DISABLE_TELEGRAM: "1",
    [`${prefix}_DATA_DIR`]: dataDir, [`${prefix}_AGENT_DIR`]: agentDir,
    [`${prefix}_CONTROL_DIR`]: controlDir, [`${prefix}_PENDING_DIR`]: path.join(dir, "pending") };
  return { root: dir, dataDir, agentDir, controlDir, env, product };
}
type Profile = ReturnType<typeof profile>;

function run(command: string, args: string[], cwd = repo): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 }).trim();
}
async function connect(p: Profile): Promise<ControlClient> {
  let client: ControlClient | undefined;
  await waitFor("后台可认证", async () => {
    try {
      client = await ControlClient.connect(path.join(p.controlDir, "control.sock"), 1000);
      await authenticateClient(client, p.controlDir);
      await client.handshake();
      return true;
    } catch { client?.close(); return false; }
  }, 90_000);
  clients.push(client!);
  return client!;
}
function launch(tree: string, p: Profile, legacy = false): ChildProcess {
  const entry = JSON.parse(fs.readFileSync(path.join(tree, "package.json"), "utf8")).bin[p.product];
  // 历史基点按它自己的能力声明选择入口；当前版本省略覆盖以验证产品默认。
  const source = [path.join(tree, "apps", p.product, "src", "product.ts"), path.join(tree, "src", p.product === "ruukoto-code" ? "product-code.ts" : "product.ts")].find(file => fs.existsSync(file));
  const declared = source ? fs.readFileSync(source, "utf8").match(/defaultExecution:\s*"(native|local|container)"/)?.[1] : undefined;
  if (legacy && !declared) throw new Error("历史基点缺少可核实的执行能力声明；请指定当前双产品身份的 SMOKE24_BASE");
  const allowed = source ? fs.readFileSync(source, "utf8").match(/allowedExecution:\s*\[([^\]]+)\]/)?.[1] : undefined;
  const historical = allowed?.includes('"native"') && !allowed.includes('"local"') ? "native" : "local";
  const backendArgs = legacy ? ["--execution", historical] : [];
  const child = spawn(process.execPath, [path.join(tree, entry), "server", ...backendArgs, "--thinking", "off"],
    { cwd: tree, env: p.env, stdio: ["ignore", "ignore", "pipe"], detached: true });
  children.push(child);
  child.stderr!.on("data", () => {});
  return child;
}
async function stop(client: ControlClient, p: Profile): Promise<void> {
  await client.request("stop");
  client.close();
  await waitFor("后台显式停止", () => !fs.existsSync(path.join(p.controlDir, "control.sock")), 30_000);
}
async function complete(client: ControlClient, session: any, key: string, real = false) {
  const task = await client.request<any>("submit", { session_id: session.id, request_id: key,
    input: real
      ? "先用 bash 运行 sleep 12 && node check.mjs，确认现有检查失败。再读取 sum.mjs 和 check.mjs，修正 sum 的初始值，然后再次用 bash 运行 node check.mjs。只修改 sum.mjs，不修改检查。最后说明检查结果。"
      : `发布验收 ${key}，请回复独立运行完成。`,
    model_selection: session.modelSelection });
  return task;
}
async function finished(client: ControlClient, taskId: string, timeout = 60_000) {
  await waitFor("任务终态", async () => ["completed", "failed", "interrupted", "canceled"].includes((await taskStatus(client, taskId)).task.status), timeout);
  const detail = await taskStatus(client, taskId);
  assert.equal(detail.task.status, "completed", String(detail.task.errorMessage ?? detail.task.interruptReason ?? "任务未完成"));
  return detail;
}
function pass(name: string) { passed++; process.stderr.write("[ruukoto:smoke24] " + `PASS ${name}` + "\n"); }

try {
  process.stderr.write("[ruukoto:smoke24] " + `环境：${process.platform} ${process.arch}，Node ${process.version}；升级基点 ${base}` + "\n");
  if (!options["upgrade-only"]) {
    const p = profile("real", "ruukoto-code");
    fs.writeFileSync(path.join(p.agentDir, "models.json"), JSON.stringify({ providers: { [providerId]: { ...provider, models: provider.models.filter((m: any) => m.id === modelId) } } }), { mode: 0o600 });
    saveDefaultModel(p.agentDir, { provider: providerId, modelId, thinkingLevel: "off" });
    const probe = spawnSync(process.execPath, ["--import", "tsx", "--input-type", "module", "--eval",
      'import { probeModelConfig } from "@ruukoto/agent/model-config.ts"; const result = await probeModelConfig(process.argv[1]); process.exitCode = result.ok ? 0 : 2;',
      p.agentDir], { cwd: repo, env: p.env, encoding: "utf8", timeout: 30_000 });
    if (probe.status !== 0) {
      failureCode = 2;
      throw new Error(`模型 ${providerId}/${modelId} 未通过离线配置与认证检查；--models 必须提供可独立调用的配置，不读取日常 auth.json 或继承模型 API key`);
    }
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "sum.mjs"), "export function sum(xs) { let total = 1; for (const x of xs) total += x; return total; }\n");
    const checkSource = 'import assert from "node:assert/strict"; import { sum } from "./sum.mjs"; assert.equal(sum([]), 0); assert.equal(sum([1,2,3]), 6); process.stdout.write("CHECK_PASS");\n';
    fs.writeFileSync(path.join(workspace, "check.mjs"), checkSource);
    const tui = spawn("python3", [path.join(repo, "verification/smoke/pty-run.py"), path.join(repo, "apps/ruukoto-code/bin/ruukoto-code.mjs"), workspace],
      { cwd: repo, env: { ...p.env, GRACE: "10" }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(tui);
    let tuiOutput = "";
    tui.stdout!.on("data", (b) => { tuiOutput += b.toString(); });
    tui.stderr!.on("data", (b) => { tuiOutput += b.toString(); });
    const tuiExit = new Promise<number | null>((resolve) => tui.once("exit", resolve));
    const client = await connect(p);
    let session: any;
    await waitFor("TUI 建立工作区会话", async () => {
      session = (await client.handshake()).snapshot.sessions.find((s) => s.cwd === workspace);
      return !!session;
    });
    const task = await complete(client, session, "real-coding", true);
    assert.equal(await tuiExit, 0);
    assert.match(tuiOutput, /已按需拉起 ruukoto-code 后台/);
    assert.match(tuiOutput, /已退出 TUI；后台任务继续运行/);
    assert.equal((await taskStatus(client, task.id)).task.status, "running", "TUI 退出时任务应仍在执行");
    const detail = await finished(client, task.id, 240_000);
    assert.equal(fs.readFileSync(path.join(workspace, "check.mjs"), "utf8"), checkSource, "模型必须修代码且保留原检查");
    assert.match(run(process.execPath, ["check.mjs"], workspace), /CHECK_PASS/);
    const checks = detail.toolOps.filter((op: any) => op.toolName === "bash");
    assert.equal(checks[0]?.isError, true, "修前检查实际失败");
    assert.equal(checks.at(-1)?.isError, false, "修后检查实际通过");
    assert.match(checks.at(-1)?.resultSummary ?? "", /CHECK_PASS/);
    assert.ok(detail.toolOps.some((op: any) => ["edit", "write"].includes(op.toolName) && !op.isError));
    assert.ok(detail.artifacts.length > 0, "保留真实工具产物");
    client.close();
    const reconnected = await connect(p);
    assert.equal((await taskStatus(reconnected, task.id)).task.status, "completed");
    await stop(reconnected, p);
    pass(`真实 ${providerId}/${modelId} 在原生沙箱内修复并通过检查，TUI 退出后继续、重连查到 ${detail.artifacts.length} 项产物`);
  } else {
  const endpoint = await model.start();
  const personal = profile("p", "ruukoto"), coding = profile("d", "ruukoto-code");
  const trees = [path.join(root, "install-personal"), path.join(root, "install-coding")];
  for (const [index, tree] of trees.entries()) {
    fs.mkdirSync(tree);
    const archive = path.join(root, `install-${index}.tar`);
    if (baseTar) fs.copyFileSync(baseTar, archive);
    else run("git", ["archive", base, "-o", archive]);
    run("tar", ["-xf", archive, "-C", tree]);
    const typesFile = ["packages/core/src/types.ts", "src/core/types.ts"].map(file => path.join(tree, file)).find(file => fs.existsSync(file));
    if (!typesFile || Number(fs.readFileSync(typesFile, "utf8").match(/export const PROTOCOL_VERSION = (\d+)/)?.[1]) !== PROTOCOL_VERSION) {
      failureCode = 2;
      throw new Error(`升级基点的控制面协议与当前客户端不兼容；请指定协议 ${PROTOCOL_VERSION} 的 SMOKE24_BASE 或 archive`);
    }
    run("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], tree);
    run("npm", ["run", "build"], tree);
  }
  await writeModelsJson(personal, endpoint);
  await writeModelsJson(coding, endpoint);
  const oldPersonal = launch(trees[0]!, personal, true);
  launch(trees[1]!, coding, true);
  let pClient = await connect(personal), dClient = await connect(coding);
  const pSnapshot = (await pClient.handshake()).snapshot, dSnapshot = (await dClient.handshake()).snapshot;
  assert.notEqual(pSnapshot.instanceId, dSnapshot.instanceId);
  const pWorkspace = path.join(root, "personal-work"), dWorkspace = path.join(root, "coding-work");
  fs.mkdirSync(pWorkspace); fs.mkdirSync(dWorkspace);
  for (const workspace of [pWorkspace, dWorkspace]) {
    fs.writeFileSync(path.join(workspace, "base.txt"), "baseline\n");
    initGitRepo(workspace);
  }
  fs.writeFileSync(path.join(root, "upgrade-approved.txt"), "approved-before-upgrade\n");
  const pSession = (await pClient.request<any>("open_workspace", { cwd: pWorkspace, request_id: "p-workspace" })).session;
  const dSession = (await dClient.request<any>("open_workspace", { cwd: dWorkspace, request_id: "d-workspace" })).session;
  const originalTask = await complete(dClient, dSession, "before-upgrade");
  await finished(dClient, originalTask.id);
  for (const [client, session, p] of [[pClient, pSession, personal], [dClient, dSession, coding]] as const) {
    const approvalTask = await complete(client, session, "preserve-approval");
    let confirmationId = "";
    await waitFor("旧版本真实越界确认", async () => {
      confirmationId = (await taskStatus(client, approvalTask.id)).confirmations.find((c: any) => c.status === "pending")?.id ?? "";
      return !!confirmationId;
    });
    await client.request("respond_confirmation", { confirmation_id: confirmationId, decision: "approve" });
    await finished(client, approvalTask.id);
    const delegated = await finished(client, (await complete(client, session, "preserve-copy")).id);
    assert.equal(delegated.toolOps.find((op: any) => op.sdkCallId === "preserve-delegate")?.isError, false, "旧版本委派须真正成功，不能把模型的完成回复当作副本成果");
    await waitFor("旧版本修改子任务完成", () => {
      const db = new DatabaseSync(path.join(p.dataDir, "ruukoto.db"), { readOnly: true });
      try {
        const child = db.prepare("SELECT t.status, t.error_message FROM tasks t JOIN work_delegations w ON t.work_id = w.id WHERE w.request_key = 'preserved-copy'").get() as any;
        if (child && ["failed", "interrupted", "canceled"].includes(child.status)) throw new Error(`旧版本子任务 ${child.status}：${child.error_message ?? "无错误正文"}`);
        return child?.status === "completed";
      } finally { db.close(); }
    });
  }
  pass("两份独立安装以各自配置、数据、控制面并存且实例标识不同");

  for (const [index, p] of [coding, personal].entries()) {
    const client = index === 0 ? dClient : pClient;
    const survivor = index === 0 ? oldPersonal : children.at(-1)!;
    const survivorClient = index === 0 ? pClient : dClient;
    const survivorProfile = index === 0 ? personal : coding;
    const survivorSession = index === 0 ? pSession : dSession;
    await stop(client, p);
    assert.equal(survivor.exitCode, null);
    assert.equal((await survivorClient.handshake()).snapshot.instanceId, index === 0 ? pSnapshot.instanceId : dSnapshot.instanceId);
    await finished(survivorClient, (await complete(survivorClient, survivorSession, `other-stopped-${index}`)).id);
    const dbPath = path.join(p.dataDir, "ruukoto.db");
    const db = new DatabaseSync(dbPath);
    let durable: { confirmations: any[]; works: any[]; artifacts: Map<string, Buffer>; histories: Map<string, Buffer>; child: any; copy: string; workId: string; modelCalls: number };
    try {
      const work = db.prepare("SELECT * FROM work_delegations WHERE request_key = 'preserved-copy'").get() as any;
      assert.ok(work?.write_target, "旧版本必须实际创建修改副本");
      const target = JSON.parse(work.write_target);
      assert.equal(target.kind, "worktree");
      const child = db.prepare("SELECT * FROM tasks WHERE work_id = ? ORDER BY created_at LIMIT 1").get(work.id) as any;
      await waitFor("旧版本子任务完成", () => (db.prepare("SELECT status FROM tasks WHERE id = ?").get(child.id) as any).status === "completed");
      const copy = path.join(target.path, "preserved-copy.txt");
      assert.equal(fs.readFileSync(copy, "utf8"), "copy-before-upgrade\n");
      // 裸 SQL 播种已知的停止未核实形态；真实强杀与回收另由服务器 smoke 验证。
      db.exec("BEGIN");
      db.prepare("UPDATE tasks SET status = 'interrupted', interrupt_reason = 'tool_process_unreaped', effect_unknown = 1 WHERE id = ?").run(child.id);
      db.prepare("UPDATE sessions SET queue_state = 'paused', queue_pause_reason = 'occupancy_unverified' WHERE id = ?").run(child.session_id);
      db.prepare("UPDATE sub_agents SET state = 'unverified' WHERE id = ?").run(child.sub_agent_id);
      const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(child.session_id) as any;
      const copyIdentity = fs.statSync(target.path);
      db.prepare("INSERT INTO occupancy VALUES (?, ?, ?, ?, ?, ?)").run(target.path, copyIdentity.dev, copyIdentity.ino, session.id, child.id, new Date().toISOString());
      db.exec("COMMIT");
      retainedTasks.set(p.controlDir, child.id);
      durable = {
        confirmations: db.prepare("SELECT * FROM confirmations ORDER BY id").all(),
        works: db.prepare("SELECT * FROM work_delegations ORDER BY id").all(),
        artifacts: new Map(db.prepare("SELECT id FROM artifacts").all().map(row => [String(row.id), fs.readFileSync(path.join(p.dataDir, "artifacts", `${row.id}.bin`))])),
        histories: new Map(db.prepare("SELECT session_file FROM sessions WHERE session_file IS NOT NULL").all().map(row => [String(row.session_file), fs.readFileSync(String(row.session_file))])),
        child, copy, workId: work.id, modelCalls: workModelCalls(work.id),
      };
      assert.ok(durable.confirmations.some(c => c.status === "approved" && c.consumed_at), "保全实际单次消费的审批");
      assert.ok(durable.artifacts.size > 0);
      assert.ok(durable.modelCalls > 0, "旧版本子上下文实际调用过模型桩");
    } finally { db.close(); }
    const tree = index === 0 ? trees[1]! : trees[0]!;
    for (const name of ["src", "bin", "packages", "apps", "scripts"]) fs.rmSync(path.join(tree, name), { recursive: true, force: true });
    for (const name of ["packages", "apps", "scripts"]) fs.cpSync(path.join(repo, name), path.join(tree, name), { recursive: true, filter: (source) => path.basename(source) !== "node_modules" });
    for (const name of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json"]) fs.copyFileSync(path.join(repo, name), path.join(tree, name));
    run("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], tree);
    run("npm", ["run", "build"], tree);
    for (const backend of ["local", "container"]) {
      for (const override of ["argument", "environment"]) {
        const rejectDir = path.join(p.root, "reject-" + backend + "-" + override);
        const rejectEnv = { ...p.env,
          [p.product === "ruukoto" ? "RUUKOTO_CONTROL_DIR" : "RUUKOTO_CODE_CONTROL_DIR"]: path.join(rejectDir, "control"),
          ...(override === "environment" ? { RUUKOTO_EXECUTION_BACKEND: backend } : {}),
        };
        const entry = JSON.parse(fs.readFileSync(path.join(tree, "package.json"), "utf8")).bin[p.product];
        const rejected = spawnSync(process.execPath, [path.join(tree, entry), "server", "--data-dir", path.join(rejectDir, "data"), "--agent-dir", path.join(rejectDir, "agent"),
          ...(override === "argument" ? ["--execution", backend] : [])], { cwd: tree, env: rejectEnv, encoding: "utf8", timeout: 10000 });
        assert.equal(rejected.error, undefined, "旧配置须直接拒绝，不能启动后台等待超时");
        assert.notEqual(rejected.status, 0, `${p.product} 必须拒绝 ${override} ${backend}`);
        assert.match(rejected.stderr, /native/, "给出 native 迁移指引");
        assert.equal(fs.existsSync(path.join(rejectDir, "data", "runtime.lock")), false, "旧配置拒绝前不启动后台");
      }
    }
    const updated = launch(tree, p);
    const next = await connect(p);
    if (index === 0) dClient = next; else pClient = next;
    const upgradedSnapshot = (await next.handshake()).snapshot;
    assert.equal(upgradedSnapshot.instanceId, index === 0 ? dSnapshot.instanceId : pSnapshot.instanceId);
    assert.equal(upgradedSnapshot.execution.backend, "native");
    const upgradedDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.deepEqual(upgradedDb.prepare("SELECT * FROM confirmations ORDER BY id").all(), durable.confirmations);
      assert.deepEqual(upgradedDb.prepare("SELECT * FROM work_delegations ORDER BY id").all(), durable.works);
      const retained = upgradedDb.prepare("SELECT status, effect_unknown FROM tasks WHERE id = ?").get(durable.child.id) as any;
      assert.deepEqual({ ...retained }, { status: "interrupted", effect_unknown: 1 });
      assert.equal((upgradedDb.prepare("SELECT state FROM sub_agents WHERE id = ?").get(durable.child.sub_agent_id) as any).state, "unverified");
      const paused = upgradedDb.prepare("SELECT queue_state, queue_pause_reason FROM sessions WHERE id = ?").get(durable.child.session_id) as any;
      assert.deepEqual({ ...paused }, { queue_state: "paused", queue_pause_reason: "occupancy_unverified" });
      assert.equal((upgradedDb.prepare("SELECT task_id FROM occupancy").get() as any).task_id, durable.child.id);
    } finally { upgradedDb.close(); }
    for (const [id, bytes] of durable.artifacts) assert.deepEqual(fs.readFileSync(path.join(p.dataDir, "artifacts", `${id}.bin`)), bytes);
    for (const [file, bytes] of durable.histories) assert.deepEqual(fs.readFileSync(file).subarray(0, bytes.length), bytes);
    assert.equal(fs.readFileSync(durable.copy, "utf8"), "copy-before-upgrade\n");
    assert.equal(survivor.exitCode, null);
    assert.ok(updated.pid && survivor.pid && updated.pid !== survivor.pid);
    const upgradedDetail = await finished(next, (await complete(next, index === 0 ? dSession : pSession, `after-upgrade-${index}`)).id);
    assert.equal(upgradedDetail.toolOps.find((op: { sdkCallId: string }) => op.sdkCallId === "upgrade-native")?.isError, false, "升级后 bash 必须由真实工具成功执行");
    assert.equal(fs.readFileSync(path.join(index === 0 ? dWorkspace : pWorkspace, "upgraded-native.txt"), "utf8"), "native\n");
    assert.equal(workModelCalls(durable.workId), durable.modelCalls, "保留的效果未知子任务不调用模型或重放工具");
    pass(`${p.product} 从 ${base} 独立升级到当前源码，另一端未重启且停端期间仍完成任务`);
    assert.ok(survivorProfile.controlDir !== p.controlDir);
  }
  assert.equal((await taskStatus(dClient, originalTask.id)).task.status, "completed");
  const history = await dClient.request<any>("read_history", { session_id: dSession.id, limit: 100 });
  assert.match(JSON.stringify(history), /before-upgrade/);
  await stop(pClient, personal);
  await finished(dClient, (await complete(dClient, dSession, "personal-offline")).id);
  await stop(dClient, coding);
  pass("升级前历史可查，分别停止，个人端离线后编码端完成本地任务");
  }
  process.stderr.write("[ruukoto:smoke24] " + `结果：${passed}/${passed} 通过；真实 IM 未涉及；模式：${options["upgrade-only"] ? "模拟模型升级" : "真实模型编码"}` + "\n");
} catch (err) {
  process.stderr.write("[ruukoto:smoke24] " + `${failureCode === 2 ? "前提缺失" : "FAIL 发布验收"}：${(err as Error).message}` + "\n");
  process.exitCode = failureCode;
} finally {
  let cleanupFailed = false;
  for (const controlDir of controls.keys()) {
    try {
      const client = await ControlClient.connect(path.join(controlDir, "control.sock"), 1000);
      await authenticateClient(client, controlDir);
      await client.request("stop"); client.close();
      await waitFor("清理后台", () => !fs.existsSync(path.join(controlDir, "control.sock")), 20_000);
    } catch { /* 下方终止本次进程，并以实例锁核实是否已退出。 */ }
  }
  for (const client of clients) client.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null && child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* 锁检查决定是否保留现场。 */ } }
  }
  await model.close().catch((err: Error) => {
    process.stderr.write("[ruukoto:smoke24] " + `FAIL 关闭模型桩：${err.message}` + "\n");
    process.exitCode = 1;
    cleanupFailed = true;
  });
  for (const lock of controls.values()) {
    try { await waitFor("核实本次后台已退出", () => !probeLockHolder(lock).held, 10_000); }
    catch {
      process.stderr.write("[ruukoto:smoke24] " + `FAIL 清理：后台退出未核实，保留临时档案 ${root}；${probeLockHolder(lock).detail}` + "\n");
      process.exitCode = 1;
      cleanupFailed = true;
    }
  }
  for (const controlDir of controls.keys()) {
    const database = path.join(path.dirname(controlDir), "data", "ruukoto.db");
    if (!fs.existsSync(database)) continue;
    try {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const rows = db.prepare("SELECT task_id FROM occupancy").all();
        assert.deepEqual(rows.map(row => row.task_id), retainedTasks.has(controlDir) ? [retainedTasks.get(controlDir)] : [], "仅保留本次明确播种的异常占用，不能清掉未知现场或漏掉新单元");
      } finally { db.close(); }
    } catch (error) {
      cleanupFailed = true;
      process.exitCode = 1;
      process.stderr.write(`[ruukoto:smoke24] 停止未核实，保留档案 ${root}；${String(error)}\n`);
    }
  }
  if (!cleanupFailed && !process.exitCode && retainedTasks.size === 0) fs.rmSync(root, { recursive: true, force: true });
  else if (process.exitCode) process.stderr.write(`[ruukoto:smoke24] 失败档案保留 ${root}\n`);
  else if (!cleanupFailed) process.stderr.write(`[ruukoto:smoke24] 预期保留异常占用档案 ${root}；任务 ${[...retainedTasks.values()].join(", ")}\n`);
}
