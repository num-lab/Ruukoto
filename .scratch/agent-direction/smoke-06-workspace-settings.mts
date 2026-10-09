/**
 * 工作区设置与资料授权的产品级冒烟（agent-direction issue 06，ADR 0017）。
 *
 * 模型层打桩（MockModelServer，确定性脚本），其余全真：真实 bin/ruukoto-code.mjs
 * 后台进程（两次拉起）、真实 socket / SQLite / 文件系统与控制面协议。
 *
 * 覆盖（与工单 06 验收标准对应）：
 *  1. 拉起真实 bin 后台（server 模式，--tools mock，models.json 指向 MockModelServer）；
 *  2. open_workspace 打开两个工作区 R 与 S（不同真实目录；R 根目录与子目录各放
 *     同名 TEAM.md，内容不同标记）；
 *  3. 保存设置：带期望版本成功；陈旧期望版本 version_conflict 且配置未变；
 *     兼容写入（不带版本）递增同一版本；
 *  4. 执行任务：R 的根目录会话与子目录会话各自提交并完成；模型收到的调用含
 *     根目录 TEAM.md 标记、不含子目录同名文件标记；
 *  5. 资料授权：S → R 的 history 授权创建，撤销后 list_data_grants 核实 revokedAt；
 *  6. 旧项目认领：create_project 旧项目先存指令并与 S 建授权，open_workspace 携带
 *     project_id 认领含该指令文件的根目录（配置/授权保留），同一 request_id 重发
 *     返回原会话、不复制项目与会话；
 *  7. 重启持久化：stop 后以同一档案重新拉起，三个工作区（含认领后的旧项目根目录
 *     归属与指令）、指令列表、settingsVersion、会话历史与授权撤销状态都在（SQLite
 *     真实持久）。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL。所有路径位于 TMPDIR 下的 makeTestDirs
 * 临时档案，不触碰日常实例。
 * 运行：npx tsx .scratch/agent-direction/smoke-06-workspace-settings.mts
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../../src/control/client.ts";
import { MockModelServer } from "../../test/helpers/mock-provider.ts";
import { authenticateClient, makeTestDirs, cleanupDirs, taskStatus, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
import { killProcessTree } from "../../test/helpers/backend.ts";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const startedAt = Date.now();

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}

const { dirs } = await makeTestDirs("smoke06", 0);
const controlDir = path.join(dirs.root, "control");
const server = new MockModelServer(async () => ({ kind: "text", text: "pong" }));
const baseUrl = await server.start();
await writeModelsJson(dirs, baseUrl);

let child!: childProcess.ChildProcess;
let stderr = "";
function spawnBackend(): void {
  child = childProcess.spawn(
    process.execPath,
    [path.join(repoRoot, "bin", "ruukoto-code.mjs"), "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--tools", "mock"],
    {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_CODE_CONTROL_DIR: controlDir },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    },
  );
  stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
}

async function connect(): Promise<ControlClient> {
  const socketPath = path.join(controlDir, "control.sock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`后台提前退出：${stderr.slice(0, 2000)}`);
    }
    try {
      const client = await ControlClient.connect(socketPath, 1500);
      await authenticateClient(client, controlDir);
      await client.handshake();
      return client;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`后台连接超时：${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function requestError(client: ControlClient, op: string, params: Record<string, unknown>): Promise<{ code: string; message: string }> {
  try {
    await client.request(op, params);
  } catch (err) {
    const e = err as Error & { code?: string };
    return { code: String(e.code ?? ""), message: e.message };
  }
  throw new Error(`${op} 应该失败但成功了`);
}

async function stopBackend(client: ControlClient): Promise<number | null> {
  await client.request("stop");
  client.close();
  return await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve(null), 20_000);
    child.once("exit", (c0) => {
      clearTimeout(timer);
      resolve(c0);
    });
  });
}

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
/** 某次提交之后模型收到的新调用拼成的文本（用于指令注入断言）。 */
const callPayload = (fromIndex: number): string => JSON.stringify(server.calls.slice(fromIndex).map((c) => c.messages));

// 工作区目录：R（根目录与子目录各放同名 TEAM.md）与 S
const dirR = path.join(dirs.root, "workspace-R");
const subR = path.join(dirR, "sub");
fs.mkdirSync(subR, { recursive: true });
fs.writeFileSync(path.join(dirR, "TEAM.md"), "根目录约定：ROOT-INSTRUCTION-MARK");
fs.writeFileSync(path.join(subR, "TEAM.md"), "子目录同名：SUB-INSTRUCTION-MARK");
const dirS = path.join(dirs.root, "workspace-S");
fs.mkdirSync(dirS, { recursive: true });
fs.writeFileSync(path.join(dirS, "TEAM.md"), "工作区 S 约定：S-INSTRUCTION-MARK");
// 旧项目认领的目标根目录：含旧项目配置的指令文件
const dirLegacy = path.join(dirs.root, "workspace-legacy");
fs.mkdirSync(dirLegacy, { recursive: true });
fs.writeFileSync(path.join(dirLegacy, "LEGACY.md"), "旧项目指令：LEGACY-INSTRUCTION-MARK");

spawnBackend();
let client: ControlClient | null = null;
try {
  client = await connect();
  const c = client;

  // ---------- 场景 2：打开两个工作区 ----------
  const wsR = (await c.request<any>("open_workspace", { cwd: dirR, request_id: "boot-r" })) as any;
  const wsS = (await c.request<any>("open_workspace", { cwd: dirS, request_id: "boot-s" })) as any;
  const projectR = wsR.session.projectId as string;
  const projectS = wsS.session.projectId as string;
  const subSession = (await c.request<any>("create_session", { project_id: projectR, cwd: subR })) as any;

  await check("场景2 open_workspace：两个不同真实目录各自成工作区", () => {
    assert.equal(wsR.createdProject, true);
    assert.equal(wsS.createdProject, true);
    assert.notEqual(projectR, projectS, "R 与 S 是不同工作区");
    assert.equal(wsR.session.cwdReal, fs.realpathSync(dirR));
    assert.equal(subSession.projectId, projectR, "子目录会话归属工作区 R");
  });

  // ---------- 场景 3：保存设置（版本保护 + 兼容写入） ----------
  await check("场景3 保存设置：带期望版本成功；陈旧版本 version_conflict 且配置未变；兼容写入递增版本", async () => {
    const saved = (await c.request<any>("set_project_instructions", {
      project_id: projectR, files: ["TEAM.md"], expected_version: 1,
    })) as any;
    assert.equal(saved.settingsVersion, 2, "带期望版本保存成功并递增");
    assert.deepEqual(saved.instructionFiles, ["TEAM.md"]);

    const conflict = await requestError(c, "set_project_instructions", {
      project_id: projectR, files: ["OTHER.md"], expected_version: 1,
    });
    assert.equal(conflict.code, "version_conflict", "陈旧期望版本 → version_conflict");
    const snapAfterConflict = (await c.handshake()).snapshot;
    const rAfterConflict = snapAfterConflict.projects.find((p: any) => p.id === projectR);
    assert.deepEqual(rAfterConflict.instructionFiles, ["TEAM.md"], "冲突不改配置");
    assert.equal(rAfterConflict.settingsVersion, 2, "冲突不递增版本");

    // 兼容写入（旧入口省略版本）：递增同一版本，且不动指令列表
    const legacy = (await c.request<any>("set_project_web_search", {
      project_id: projectR, enabled: false,
    })) as any;
    assert.equal(legacy.settingsVersion, 3, "兼容写入递增同一版本");
    const snap = (await c.handshake()).snapshot;
    const rNow = snap.projects.find((p: any) => p.id === projectR);
    assert.deepEqual(rNow.instructionFiles, ["TEAM.md"], "开关写入不动指令列表");
  });

  // ---------- 场景 4：执行任务（指令按根目录读取） ----------
  await check("场景4 执行任务：R 根目录会话与子目录会话均只注入根目录 TEAM.md", async () => {
    for (const [label, sessionId, requestId] of [
      ["根目录会话", wsR.session.id as string, "task-r-root"],
      ["子目录会话", subSession.id as string, "task-r-sub"],
    ] as const) {
      const before = server.calls.length;
      const task = (await c.request<any>("submit", {
        session_id: sessionId, request_id: requestId, input: `smoke06-${label}`, model_selection: MODEL,
      })) as any;
      await waitFor(`${label}任务完成`, async () => (await taskStatus(c, task.id)).task.status === "completed");
      const payload = callPayload(before);
      assert.ok(payload.includes("[项目指令]"), `${label}应收到项目指令参考块`);
      assert.ok(payload.includes("ROOT-INSTRUCTION-MARK"), `${label}注入根目录 TEAM.md 内容`);
      assert.ok(!payload.includes("SUB-INSTRUCTION-MARK"), `${label}不得读取子目录同名文件`);
    }
  });

  // ---------- 场景 5：授权 / 撤销 ----------
  let grantId = "";
  await check("场景5 资料授权：S→R history 授权创建，撤销后 revokedAt 可核实", async () => {
    const grant = (await c.request<any>("create_data_grant", {
      from_project_id: projectS, to_project_id: projectR, category: "history", purpose: "smoke06 冒烟",
    })) as any;
    grantId = grant.id;
    assert.equal(grant.revokedAt, null, "新建授权未撤销");
    const active = ((await c.request<any>("list_data_grants", {})) as any).grants as any[];
    assert.ok(active.some((g) => g.id === grantId), "默认列表含有效授权");

    await c.request("revoke_data_grant", { grant_id: grantId });
    const activeAfter = ((await c.request<any>("list_data_grants", {})) as any).grants as any[];
    assert.ok(!activeAfter.some((g) => g.id === grantId), "撤销后默认列表不再含该授权");
    const all = ((await c.request<any>("list_data_grants", { include_revoked: true })) as any).grants as any[];
    const revoked = all.find((g) => g.id === grantId);
    assert.ok(revoked, "含撤销记录的列表仍可查该授权");
    assert.ok(typeof revoked.revokedAt === "string" && revoked.revokedAt.length > 0, "revokedAt 已记录");
  });

  // ---------- 场景 6：旧项目认领 ----------
  let legacyId = "";
  let legacyGrantId = "";
  await check("场景6 旧项目认领：配置与授权保留；同一 request_id 重发不复制状态", async () => {
    const legacy = (await c.request<any>("create_project", { name: "legacy-proj" })) as any;
    legacyId = legacy.id as string;
    const snapBefore = (await c.handshake()).snapshot;
    assert.equal(snapBefore.projects.find((p: any) => p.id === legacyId).rootDir, null, "旧项目无根目录归属");
    const projectCount = snapBefore.projects.length;

    // 旧入口风格保存指令（带期望版本），并建立 S → 旧项目 的 history 授权
    const saved = (await c.request<any>("set_project_instructions", {
      project_id: legacyId, files: ["LEGACY.md"], expected_version: 1,
    })) as any;
    assert.equal(saved.settingsVersion, 2, "旧项目指令保存成功");
    const grant = (await c.request<any>("create_data_grant", {
      from_project_id: projectS, to_project_id: legacyId, category: "history", purpose: "smoke06 认领前授权",
    })) as any;
    legacyGrantId = grant.id as string;

    // open_workspace 携带 project_id 认领含该指令文件的根目录
    const adopted = (await c.request<any>("open_workspace", {
      cwd: dirLegacy, project_id: legacyId, request_id: "adopt-1",
    })) as any;
    assert.equal(adopted.createdProject, false, "认领不新建项目");
    assert.equal(adopted.session.projectId, legacyId, "认领后会话归属旧项目");
    const snap = (await c.handshake()).snapshot;
    const kept = snap.projects.find((p: any) => p.id === legacyId);
    assert.equal(kept.rootDir?.cwdReal, fs.realpathSync(dirLegacy), "认领根目录归属正确");
    assert.deepEqual(kept.instructionFiles, ["LEGACY.md"], "指令列表保留");
    assert.equal(kept.settingsVersion, 2, "认领不改设置版本");
    const active = ((await c.request<any>("list_data_grants", {})) as any).grants as any[];
    assert.ok(active.some((g) => g.id === legacyGrantId), "认领后授权仍在");

    // 同一 request_id 重发：返回原会话，项目/会话不复制（幂等，不重复迁移）
    const again = (await c.request<any>("open_workspace", {
      cwd: dirLegacy, project_id: legacyId, request_id: "adopt-1",
    })) as any;
    assert.equal(again.session.id, adopted.session.id, "同一请求标识返回原会话");
    assert.equal(again.createdProject, false);
    const snapAgain = (await c.handshake()).snapshot;
    assert.equal(snapAgain.projects.length, projectCount, "项目不复制");
    assert.equal(snapAgain.sessions.filter((s: any) => s.createRequestId === "adopt-1").length, 1, "会话不复制");
  });

  // ---------- 场景 7：重启持久化 ----------
  await check("场景7 重启持久化：同一档案重新拉起，工作区/设置/历史/撤销/认领归属都在", async () => {
    const code = await stopBackend(c);
    client = null;
    assert.equal(code, 0, "后台正常停止");

    spawnBackend();
    const c2 = await connect();
    client = c2;
    const snap = (await c2.handshake()).snapshot;

    const workspaces = snap.projects.filter((p: any) => p.rootDir);
    assert.equal(workspaces.length, 3, "重启后三个工作区都在（R、S、认领后的旧项目）");
    const rNow = snap.projects.find((p: any) => p.id === projectR);
    const sNow = snap.projects.find((p: any) => p.id === projectS);
    assert.ok(rNow?.rootDir && sNow?.rootDir, "R 与 S 按原标识在档");
    assert.equal(rNow.rootDir.cwdReal, fs.realpathSync(dirR));
    assert.deepEqual(rNow.instructionFiles, ["TEAM.md"], "指令列表持久");
    assert.equal(rNow.settingsVersion, 3, "settingsVersion 持久");
    assert.equal(rNow.webSearch, "disabled", "Web Search 开关持久");

    // 认领后的旧项目：根目录归属与指令在重启后仍在
    const legacyNow = snap.projects.find((p: any) => p.id === legacyId);
    assert.equal(legacyNow?.rootDir?.cwdReal, fs.realpathSync(dirLegacy), "旧项目根目录归属持久");
    assert.deepEqual(legacyNow?.instructionFiles, ["LEGACY.md"], "旧项目指令列表持久");
    assert.equal(legacyNow?.settingsVersion, 2, "旧项目 settingsVersion 持久");
    const activeGrants = ((await c2.request<any>("list_data_grants", {})) as any).grants as any[];
    assert.ok(
      activeGrants.some((g) => g.id === legacyGrantId && g.fromProjectId === projectS && g.toProjectId === legacyId),
      "旧项目授权（有效）持久",
    );

    const rootHistory = (await c2.request<any>("read_history", { session_id: wsR.session.id })) as any;
    const rootText = JSON.stringify(rootHistory);
    assert.ok(rootText.includes("smoke06-根目录会话"), "根目录会话历史持久");
    assert.ok(rootText.includes("pong"), "模型应答持久");
    const subHistory = (await c2.request<any>("read_history", { session_id: subSession.id })) as any;
    assert.ok(JSON.stringify(subHistory).includes("smoke06-子目录会话"), "子目录会话历史持久");

    const all = ((await c2.request<any>("list_data_grants", { include_revoked: true })) as any).grants as any[];
    const revoked = all.find((g) => g.id === grantId);
    assert.ok(revoked && typeof revoked.revokedAt === "string" && revoked.revokedAt.length > 0, "授权撤销状态持久");
    assert.equal(revoked.fromProjectId, projectS);
    assert.equal(revoked.toProjectId, projectR);

    const code2 = await stopBackend(c2);
    client = null;
    assert.equal(code2, 0, "第二次后台正常停止");
  });
} finally {
  if (client) client.close();
  if (child.exitCode === null && child.signalCode === null) killProcessTree(child);
  await server.close();
  await cleanupDirs(dirs);
}

const failed = results.filter((r) => !r.ok);
console.log("\n模拟：模型服务（MockModelServer，本地 OpenAI 兼容打桩，确定性应答）");
console.log("真实：bin/ruukoto-code.mjs 后台进程（两次拉起）、控制面 socket、SQLite 数据库、文件系统与目录身份、控制协议全部操作");
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过（环境：${process.platform} ${process.arch}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
if (failed.length > 0) process.exit(1);
