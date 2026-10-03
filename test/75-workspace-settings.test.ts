/**
 * 工作区管理配置与资料授权（agent-direction issue 06，ADR 0017）。
 *
 * 测试接缝（预先约定）：
 * 1. 项目设置并发保护：projects.settings_version 只保护指令列表与 Web Search；
 *    新客户端携带期望版本，旧版本保存失败为 version_conflict（不改配置、不产生
 *    成功事件），重读后可保存；兼容写入（省略版本）仍更新同一行、递增同一版本
 *    并产生同一事件；修改项目 A 的设置不影响项目 B；schema v19 旧库升级到当前
 *    版本后旧项目获得初始版本。
 * 2. 事件投影：project.settings_changed 携带项目、设置版本与配置字段（无指令
 *    正文），任务 TUI 与配置中心据此刷新。
 * 3. 指令按工作区根目录读取与钉版时机（步骤 2/4 串联）：工作区根目录会话与
 *    子目录会话都只读根目录文件（子目录同名文件不出现）；运行中任务沿用钉版，
 *    下一任务读新值，排队任务在排队期间被修改后启动时读当前值；同名目录的另
 *    一个真实路径是另一个配置键，修改互不影响。
 * 4. 资料授权边界（步骤 4）：history/memory/artifact 三类别分别经历默认拒绝 →
 *    create_data_grant 后可读 → 撤销最后一条有效授权后拒绝；授权有方向（A→B
 *    不反向）、类别不互开、不传递到第三工作区；两个等价授权撤一条仍可读；任务
 *    运行中撤销后下一次宿主查询即被拒。旧项目认领保持配置/授权/凭据引用，旧
 *    入口写入产生同一事件；幂等键重复认领不复制状态；MCP 凭据 scope 不扩大。
 * 5. store 层：updateProjectSettings 同值保存幂等（不递增版本、不产生事件），
 *    改动保存递增并发事件。
 *
 * 本文件只做离线进程级断言（模型打桩，进程/文件/socket/SQLite 真实）；真实环境
 * 验证记录见 .scratch/agent-direction/smoke-06-workspace-settings.mts 与工单 Comments。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db, SCHEMA_VERSION } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import {
  startTestRuntime,
  waitFor,
  taskStatus,
  lastUserText,
  realTools,
  type TestRuntime,
} from "./helpers/testkit.ts";
import type { Responder } from "./helpers/mock-provider.ts";

const RESPONDER = async () => ({ kind: "text", text: "x" }) as const;
const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

async function requestError(client: TestRuntime["client"], op: string, params: Record<string, unknown>): Promise<{ code: string; message: string }> {
  try {
    await client.request(op, params);
  } catch (err) {
    const e = err as Error & { code?: string };
    return { code: String(e.code ?? ""), message: e.message };
  }
  throw new Error(`${op} 应该失败但成功了`);
}

function settingsEvents(t: TestRuntime, projectId: string) {
  return t.runtime.store
    .getEventsAfter(0)
    .filter((e) => e.body.type === "project.settings_changed" && (e.body as { projectId: string }).projectId === projectId);
}

// ---------- 步骤 1：settings_version 并发保护 ----------

test("settings_version：携带期望版本保存成功并递增版本；旧版本冲突且不留痕迹", async () => {
  const t = await startTestRuntime("ws75-settings-version", RESPONDER);
  try {
    const project = (await t.client.request<any>("create_project", { name: "p-a" })) as any;
    assert.equal(project.settingsVersion, 1, "新项目初始设置版本为 1");

    const saved = (await t.client.request<any>("set_project_instructions", {
      project_id: project.id, files: ["AGENTS.md"], expected_version: 1,
    })) as any;
    assert.equal(saved.settingsVersion, 2, "保存后版本递增");
    assert.deepEqual(saved.instructionFiles, ["AGENTS.md"]);

    const conflict = await requestError(t.client, "set_project_instructions", {
      project_id: project.id, files: ["OTHER.md"], expected_version: 1,
    });
    assert.equal(conflict.code, "version_conflict", "旧期望版本 → version_conflict");

    const after = t.runtime.store.getProject(project.id)!;
    assert.deepEqual(after.instructionFiles, ["AGENTS.md"], "冲突不改配置");
    assert.equal(after.settingsVersion, 2, "冲突不递增版本");
    assert.equal(settingsEvents(t, project.id).length, 1, "冲突不产生成功事件");
    const event = settingsEvents(t, project.id)[0]!.body as any;
    assert.equal(event.settingsVersion, 2);
    assert.deepEqual(event.instructionFiles, ["AGENTS.md"], "事件携带配置字段");
    assert.ok(!("instructions" in event) && !("text" in event), "事件不含指令正文");

    // 重读后可保存
    const resaved = (await t.client.request<any>("set_project_instructions", {
      project_id: project.id, files: ["A.md", "B.md"], expected_version: 2,
    })) as any;
    assert.equal(resaved.settingsVersion, 3);
    assert.deepEqual(resaved.instructionFiles, ["A.md", "B.md"]);
  } finally {
    await t.shutdown();
  }
});

test("settings_version：兼容写入（省略版本）仍更新同一行并产生事件；指令与 Web Search 共用一个版本", async () => {
  const t = await startTestRuntime("ws75-settings-legacy", RESPONDER);
  try {
    const project = (await t.client.request<any>("create_project", { name: "p-legacy" })) as any;

    // 旧入口省略版本：兼容写入
    const legacy = (await t.client.request<any>("set_project_web_search", {
      project_id: project.id, enabled: false,
    })) as any;
    assert.equal(legacy.webSearch, "disabled");
    assert.equal(legacy.settingsVersion, 2, "兼容写入递增同一版本");
    assert.equal(settingsEvents(t, project.id).length, 1, "兼容写入产生同一事件");

    // 带版本客户端读到 v2 后保存指令；旧表单拿 v1 再保存被拒
    const stale = await requestError(t.client, "set_project_web_search", {
      project_id: project.id, enabled: true, expected_version: 1,
    });
    assert.equal(stale.code, "version_conflict", "旧入口写入后旧表单版本失效");
    const ws = (await t.client.request<any>("set_project_web_search", {
      project_id: project.id, enabled: true, expected_version: 2,
    })) as any;
    assert.equal(ws.settingsVersion, 3);
    assert.equal(t.runtime.store.getProject(project.id)!.instructionFiles.length, 0, "开关保存不动指令列表");
  } finally {
    await t.shutdown();
  }
});

test("settings_version：修改项目 A 不影响项目 B", async () => {
  const t = await startTestRuntime("ws75-settings-isolation", RESPONDER);
  try {
    const a = (await t.client.request<any>("create_project", { name: "p-iso-a" })) as any;
    const b = (await t.client.request<any>("create_project", { name: "p-iso-b" })) as any;
    await t.client.request("set_project_instructions", { project_id: a.id, files: ["A.md"] });
    await t.client.request("set_project_web_search", { project_id: a.id, enabled: false });
    const bAfter = t.runtime.store.getProject(b.id)!;
    assert.equal(bAfter.settingsVersion, 1, "B 的版本保持初始");
    assert.deepEqual(bAfter.instructionFiles, []);
    assert.equal(bAfter.webSearch, "enabled");
    assert.equal(settingsEvents(t, b.id).length, 0, "B 无设置事件");
  } finally {
    await t.shutdown();
  }
});

test("settings_version：v19 旧库升级到当前版本后旧项目获得初始版本 1，且不产生设置事件", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-ws75-migrate-"));
  try {
    // 先用当前版本建库，再以原始 SQL 写入旧设置值（模拟 v19 时代的库内容）
    const db = new Db(dataDir);
    const store = new Store(db);
    const project = store.withTx(() => store.createProject("旧项目"));
    db.exec(`UPDATE projects SET instruction_files = '["LEGACY.md"]', web_search = 'disabled' WHERE id = '${project.id}'`);
    // 模拟 v19 文件：去掉 settings_version 列并回退版本号
    db.exec("ALTER TABLE projects DROP COLUMN settings_version");
    db.exec("UPDATE meta SET value = '19' WHERE key = 'schema_version'");
    db.close();

    const upgraded = new Db(dataDir);
    try {
      const current = new Store(upgraded);
      const cols = (upgraded.prepare("PRAGMA table_info(projects)").all() as any[]).map((c) => c.name);
      assert.ok(cols.includes("settings_version"), "补列 settings_version");
      const p = current.getProject(project.id)!;
      assert.equal(SCHEMA_VERSION, 23, "当前 schema 为 v23");
      assert.equal(p.settingsVersion, 1, "旧项目升级为初始版本 1");
      assert.deepEqual(p.instructionFiles, ["LEGACY.md"], "旧指令列表保留");
      assert.equal(p.webSearch, "disabled", "旧开关保留");
      assert.equal(
        current.getEventsAfter(0).filter((e) => e.body.type === "project.settings_changed").length,
        0,
        "升级不产生设置事件",
      );
    } finally {
      upgraded.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- 步骤 4：工作区并存、钉版时机、资料授权与旧入口兼容串联 ----------

/** 最后一个 tool 结果消息在最后一个 user 消息之后 = 本轮工具已返回（跨任务复用历史时仍正确）。 */
function toolRoundDone(req: { messages: Array<{ role?: string }> }): boolean {
  let lastUser = -1;
  let lastTool = -1;
  req.messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
    if (m.role === "tool") lastTool = i;
  });
  return lastTool > lastUser;
}

/** 提交并等待任务终态，返回任务详情。 */
async function submitAndWait(t: TestRuntime, sessionId: string, requestId: string, input: string): Promise<{ id: string; detail: any }> {
  const task = (await t.client.request<any>("submit", {
    model_selection: MODEL, session_id: sessionId, request_id: requestId, input,
  })) as any;
  await waitFor(`任务终态 ${requestId}`, async () => {
    const s = await taskStatus(t.client, task.id);
    return ["completed", "failed", "interrupted"].includes(s.task.status);
  });
  return { id: task.id, detail: await taskStatus(t.client, task.id) };
}

/** 任务详情里某工具名的（唯一）工具操作记录。 */
function toolOp(detail: any, toolName: string): any {
  const op = (detail.toolOps as any[]).find((o) => o.toolName === toolName);
  assert.ok(op, `任务 ${detail.task?.id} 应记录 ${toolName} 工具操作`);
  return op;
}

function opByCallId(detail: any, sdkCallId: string): any {
  const op = (detail.toolOps as any[]).find((o) => o.sdkCallId === sdkCallId);
  assert.ok(op, `应记录工具操作 ${sdkCallId}`);
  return op;
}

async function openWorkspace(t: TestRuntime, cwd: string, requestId: string): Promise<any> {
  return (await t.client.request<any>("open_workspace", { cwd, request_id: requestId })) as any;
}

/** 某次提交之后模型收到的新调用拼成的文本（用于参考块断言）。 */
function callPayload(t: TestRuntime, fromIndex: number): string {
  return JSON.stringify(t.server.calls.slice(fromIndex).map((c) => c.messages));
}

test("工作区并存：根目录与子目录会话都只按根目录读指令；同名目录设置互不影响", async () => {
  const t = await startTestRuntime("ws75-two-ws", RESPONDER);
  try {
    const root = t.work[0]!;
    const sub = path.join(root, "sub");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(root, "TEAM.md"), "根目录约定：ROOT-INSTRUCTION-MARK");
    fs.writeFileSync(path.join(sub, "TEAM.md"), "子目录同名：SUB-INSTRUCTION-MARK");

    const wsR = await openWorkspace(t, root, "ws75-r");
    const projectR = wsR.session.projectId as string;
    await t.client.request("set_project_instructions", { project_id: projectR, files: ["TEAM.md"] });
    const subSession = (await t.client.request<any>("create_session", { project_id: projectR, cwd: sub })) as any;
    assert.equal(subSession.projectId, projectR, "子目录会话归属同一工作区");

    // 根目录会话与子目录会话各自提交：项目指令参考块只来自根目录 TEAM.md
    for (const [label, sessionId, requestId] of [
      ["根目录会话", wsR.session.id as string, "r-root-1"],
      ["子目录会话", subSession.id as string, "r-sub-1"],
    ] as const) {
      const before = t.server.calls.length;
      await submitAndWait(t, sessionId, requestId, `${label}任务`);
      const payload = callPayload(t, before);
      assert.ok(payload.includes("[项目指令]"), `${label}应收到项目指令参考块`);
      assert.ok(payload.includes("ROOT-INSTRUCTION-MARK"), `${label}注入根目录 TEAM.md 内容`);
      assert.ok(!payload.includes("SUB-INSTRUCTION-MARK"), `${label}不得读取子目录同名文件`);
    }

    // 工作区 S：与 R 同名目录名的另一个真实路径（不同目录身份）——另一个配置键
    const other = path.join(t.dirs.root, "other-parent", path.basename(fs.realpathSync(root)));
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "TEAM.md"), "工作区 S 约定：S-INSTRUCTION-MARK");
    const wsS = await openWorkspace(t, other, "ws75-s");
    const projectS = wsS.session.projectId as string;
    assert.notEqual(projectS, projectR, "同名目录是两个工作区（配置归属按稳定 projectId）");

    await t.client.request("set_project_instructions", { project_id: projectS, files: ["TEAM.md"] });
    await t.client.request("set_project_web_search", { project_id: projectS, enabled: false });
    const rAfter = t.runtime.store.getProject(projectR)!;
    assert.deepEqual(rAfter.instructionFiles, ["TEAM.md"], "S 的保存不影响 R 的指令列表");
    assert.equal(rAfter.webSearch, "enabled", "S 的保存不影响 R 的 Web Search");
    assert.equal(rAfter.settingsVersion, 2, "S 的保存不递增 R 的版本");
    assert.equal(settingsEvents(t, projectR).length, 1, "R 只产生自己的设置事件");

    const before = t.server.calls.length;
    await submitAndWait(t, wsS.session.id, "s-task-1", "S任务");
    const payload = callPayload(t, before);
    assert.ok(payload.includes("S-INSTRUCTION-MARK"), "S 读自己的根目录指令");
    assert.ok(!payload.includes("ROOT-INSTRUCTION-MARK"), "S 不读 R 的指令");
  } finally {
    await t.shutdown();
  }
});

test("指令钉版与应用时机：运行中任务沿用钉版；下一任务读新值；排队任务启动时读当前值", async () => {
  // 门控应答：标注输入的第二次模型调用先挂起，由测试在挂起期间改写指令文件后放行
  const arrivals = new Map<string, number>();
  const releases = new Map<string, () => void>();
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text === "长跑任务" || text === "占位任务") {
      if (!toolRoundDone(req)) {
        return { kind: "tool_calls", calls: [{ id: `d-${text}`, name: "mock_delay", arguments: { ms: 50 } }] };
      }
      const n = (arrivals.get(text) ?? 0) + 1;
      arrivals.set(text, n);
      if (n === 1) await new Promise<void>((resolve) => releases.set(text, resolve));
      return { kind: "text", text: "收尾" };
    }
    return { kind: "text", text: "ok" };
  };
  const t = await startTestRuntime("ws75-pin", responder);
  try {
    const root = t.work[0]!;
    const team = path.join(root, "TEAM.md");
    fs.writeFileSync(team, "第一版：PIN-V1");
    const wsR = await openWorkspace(t, root, "ws75-pin-r");
    const sessionId = wsR.session.id as string;
    const projectId = wsR.session.projectId as string;
    await t.client.request("set_project_instructions", { project_id: projectId, files: ["TEAM.md"] });

    // A. 任务运行期间修改指令：同一任务后续模型调用仍用钉版内容
    const before1 = t.server.calls.length;
    const task1 = (await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "pin-t1", input: "长跑任务",
    })) as any;
    await waitFor("T1 第二次模型调用挂起", () => (arrivals.get("长跑任务") ?? 0) >= 1);
    fs.writeFileSync(team, "第二版：PIN-V2");
    releases.get("长跑任务")!();
    await waitFor("T1 完成", async () => (await taskStatus(t.client, task1.id)).task.status === "completed");
    const t1Payload = callPayload(t, before1);
    assert.ok(t1Payload.includes("PIN-V1"), "运行中任务沿用钉版内容");
    assert.ok(!t1Payload.includes("PIN-V2"), "运行中任务的后续模型调用不得出现新内容");

    // B. 下一任务读取新内容
    const before2 = t.server.calls.length;
    await submitAndWait(t, sessionId, "pin-t2", "下一个任务");
    const t2Payload = callPayload(t, before2);
    assert.ok(t2Payload.includes("PIN-V2"), "下一任务读取新内容");
    assert.ok(!t2Payload.includes("PIN-V1"), "新钉版不含旧内容");
    const before3 = t.server.calls.length;

    // C. 排队任务在排队期间被修改：启动时读取当前值；占据队列的任务沿用其钉版
    const task3 = (await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "pin-t3", input: "占位任务",
    })) as any;
    const task4 = (await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "pin-t4", input: "排队任务",
    })) as any;
    await waitFor("T3 第二次模型调用挂起", () => (arrivals.get("占位任务") ?? 0) >= 1);
    assert.equal((await taskStatus(t.client, task4.id)).task.status, "queued", "T4 在 T3 运行期间保持排队");
    fs.writeFileSync(team, "第三版：PIN-V3");
    releases.get("占位任务")!();
    await waitFor("T3 完成", async () => (await taskStatus(t.client, task3.id)).task.status === "completed");
    await waitFor("T4 完成", async () => (await taskStatus(t.client, task4.id)).task.status === "completed");
    // T3 固定 2 次模型调用（工具调用 + 终答）；T4 1 次——按调用数切分，避开完成后即刻启动的竞态
    const t3Calls = t.server.calls.slice(before3, before3 + 2);
    const t4Calls = t.server.calls.slice(before3 + 2);
    assert.equal(t4Calls.length, 1, "按脚本 T3/T4 调用数固定");
    const t3Payload = JSON.stringify(t3Calls.map((c) => c.messages));
    assert.ok(t3Payload.includes("PIN-V2"), "T3 沿用其开始时的钉版");
    assert.ok(!t3Payload.includes("PIN-V3"), "T3 的后续调用不出现排队期间的新内容");
    const t4Payload = JSON.stringify(t4Calls.map((c) => c.messages));
    assert.ok(t4Payload.includes("PIN-V3"), "排队任务启动时读取当前值");
    assert.ok(!t4Payload.includes("PIN-V1") && !t4Payload.includes("PIN-V2"), "排队任务不读旧值");
  } finally {
    await t.shutdown();
  }
});

test("资料授权生命周期：history 与 memory 类别分别默认拒绝 → 授权可读 → 撤销拒绝；方向与第三工作区隔离，等价授权", async () => {
  const shared = { memA: "", memB: "" };
  let callSeq = 0;
  const oneCall = (name: string, args: Record<string, unknown>) =>
    ({ kind: "tool_calls" as const, calls: [{ id: `c${++callSeq}`, name, arguments: args }] });
  const responder: Responder = async (req) => {
    if (toolRoundDone(req)) return { kind: "text", text: "完成" };
    const text = lastUserText(req);
    if (/^(查历史|再查历史|三查历史|四查历史)$/.test(text) || text === "C查历史") {
      return oneCall("history_search", { query: "金色桥梁", role: "user" });
    }
    if (text === "B查A") return oneCall("history_search", { query: "红色风车", role: "user" });
    if (/^(读记忆|再读记忆|三读记忆|C读记忆)$/.test(text)) return oneCall("memory_read", { memory_id: shared.memB });
    if (text === "B读A记忆") return oneCall("memory_read", { memory_id: shared.memA });
    return { kind: "text", text: "好" };
  };
  const t = await startTestRuntime("ws75-grants", responder, { workDirs: 3 });
  try {
    // 三个工作区并存：A（读取方）、B（数据来源）、C（未获授权的第三方）
    const wsA = await openWorkspace(t, t.work[0]!, "ws75-g-a");
    const wsB = await openWorkspace(t, t.work[1]!, "ws75-g-b");
    const wsC = await openWorkspace(t, t.work[2]!, "ws75-g-c");
    const A = wsA.session.projectId as string;
    const B = wsB.session.projectId as string;

    await submitAndWait(t, wsB.session.id, "g-b-seed", "留下暗号：金色桥梁");
    await submitAndWait(t, wsA.session.id, "g-a-seed", "A的暗号：红色风车");
    shared.memB = ((await t.client.request<any>("save_memory", {
      project_id: B, category: "convention", content: "B的记忆：翠绿扇门",
      source_refs: [{ kind: "owner_note", note: "B 的约定" }],
    })) as any).id;
    shared.memA = ((await t.client.request<any>("save_memory", {
      project_id: A, category: "convention", content: "A的记忆：琥珀窗格",
      source_refs: [{ kind: "owner_note", note: "A 的约定" }],
    })) as any).id;

    // history：默认拒绝（B 的内容根本不进入 A 的检索范围）
    let d = await submitAndWait(t, wsA.session.id, "g-h-deny", "查历史");
    let op = toolOp(d.detail, "history_search");
    assert.match(op.resultSummary ?? "", /命中 0 条/);
    assert.ok(!String(op.resultSummary).includes("金色桥梁"), "默认拒绝：不含 B 的内容");

    // 授权 B.history → A 后可读
    const grantH1 = (await t.client.request<any>("create_data_grant", {
      from_project_id: B, to_project_id: A, category: "history",
    })) as any;
    d = await submitAndWait(t, wsA.session.id, "g-h-ok", "再查历史");
    op = toolOp(d.detail, "history_search");
    assert.ok(String(op.resultSummary).includes("金色桥梁"), "授权后应能搜到 B 的内容");

    // 类别隔离：只有 history 授权时 memory 仍拒绝
    d = await submitAndWait(t, wsA.session.id, "g-m-deny0", "读记忆");
    op = toolOp(d.detail, "memory_read");
    assert.equal(op.isError, true, "只开放 history 不开放 memory");
    assert.match(op.resultSummary ?? "", /无权读取/);

    // 方向：B→A 授权不能让 B 读 A
    d = await submitAndWait(t, wsB.session.id, "g-h-dir", "B查A");
    op = toolOp(d.detail, "history_search");
    assert.match(op.resultSummary ?? "", /命中 0 条/, "授权有方向：B 读不到 A 的内容");
    // 不传递到第三工作区 C
    d = await submitAndWait(t, wsC.session.id, "g-h-c", "C查历史");
    op = toolOp(d.detail, "history_search");
    assert.match(op.resultSummary ?? "", /命中 0 条/, "授权不传递到 C");

    // 等价授权：两条同 from/to/category 并存，撤一条仍可读，撤销最后一条后拒绝
    const grantH2 = (await t.client.request<any>("create_data_grant", {
      from_project_id: B, to_project_id: A, category: "history",
    })) as any;
    await t.client.request("revoke_data_grant", { grant_id: grantH1.id });
    d = await submitAndWait(t, wsA.session.id, "g-h-still", "三查历史");
    op = toolOp(d.detail, "history_search");
    assert.ok(String(op.resultSummary).includes("金色桥梁"), "还有一条有效授权时仍可读");
    await t.client.request("revoke_data_grant", { grant_id: grantH2.id });
    d = await submitAndWait(t, wsA.session.id, "g-h-final", "四查历史");
    op = toolOp(d.detail, "history_search");
    assert.match(op.resultSummary ?? "", /命中 0 条/, "撤销最后一条有效授权后拒绝");
    assert.ok(!String(op.resultSummary).includes("金色桥梁"));

    // memory：默认拒绝（上一步已验证 history 授权不覆盖 memory）→ 授权可读
    const grantM = (await t.client.request<any>("create_data_grant", {
      from_project_id: B, to_project_id: A, category: "memory",
    })) as any;
    d = await submitAndWait(t, wsA.session.id, "g-m-ok", "再读记忆");
    op = toolOp(d.detail, "memory_read");
    assert.notEqual(op.isError, true, "授权后可读 B 的记忆");
    assert.ok(String(op.resultSummary).includes("翠绿扇门"));

    // 方向与第三工作区：B 读不到 A 的记忆，C 读不到 B 的记忆
    d = await submitAndWait(t, wsB.session.id, "g-m-dir", "B读A记忆");
    op = toolOp(d.detail, "memory_read");
    assert.equal(op.isError, true, "授权有方向：B 读不到 A 的记忆");
    assert.match(op.resultSummary ?? "", /无权读取/);
    d = await submitAndWait(t, wsC.session.id, "g-m-c", "C读记忆");
    op = toolOp(d.detail, "memory_read");
    assert.equal(op.isError, true, "授权不传递到 C 的记忆读取");

    // 撤销后拒绝
    await t.client.request("revoke_data_grant", { grant_id: grantM.id });
    d = await submitAndWait(t, wsA.session.id, "g-m-final", "三读记忆");
    op = toolOp(d.detail, "memory_read");
    assert.equal(op.isError, true, "撤销后拒绝");
    assert.ok(!String(op.resultSummary).includes("翠绿扇门"), "撤销后不再读到内容");
  } finally {
    await t.shutdown();
  }
});

test("资料授权生命周期：artifact 类别（read_artifact 接缝）—— 默认拒绝 → 授权可读 → 撤销拒绝；只开产物不开历史，授权有方向", async () => {
  const holder = { artA: "", artB: "" };
  let callSeq = 0;
  const oneCall = (name: string, args: Record<string, unknown>) =>
    ({ kind: "tool_calls" as const, calls: [{ id: `c${++callSeq}`, name, arguments: args }] });
  const responder: Responder = async (req) => {
    if (toolRoundDone(req)) return { kind: "text", text: "完成" };
    const text = lastUserText(req);
    if (text === "产生产物") return oneCall("bash", { command: "echo 产物标记：紫铜罗盘" });
    if (text === "A产生产物") return oneCall("bash", { command: "echo A产物标记：白银刻度" });
    if (/^(读别的产物|再读产物|末读产物)$/.test(text)) return oneCall("read_artifact", { artifact_id: holder.artB });
    if (text === "B读A产物") return oneCall("read_artifact", { artifact_id: holder.artA });
    if (text === "查历史") return oneCall("history_search", { query: "银杏灯笼", role: "user" });
    return { kind: "text", text: "好" };
  };
  const t = await startTestRuntime("ws75-artifact", responder, { workDirs: 2, config: realTools() });
  try {
    const wsA = await openWorkspace(t, t.work[0]!, "ws75-art-a");
    const wsB = await openWorkspace(t, t.work[1]!, "ws75-art-b");
    const A = wsA.session.projectId as string;
    const B = wsB.session.projectId as string;

    // B 的 bash stdout 捕获为产物；B 的历史里另留一个只存在于历史类别的暗号
    let d = await submitAndWait(t, wsB.session.id, "art-b-hist", "记住暗号：银杏灯笼");
    d = await submitAndWait(t, wsB.session.id, "art-b-seed", "产生产物");
    const artB = (d.detail.artifacts as any[]).find((a) => a.name.includes("stdout"));
    assert.ok(artB, "B 应承担 stdout 产物");
    holder.artB = artB.id;

    // 默认拒绝：跨项目任务读不到 B 的产物
    d = await submitAndWait(t, wsA.session.id, "art-deny", "读别的产物");
    let op = toolOp(d.detail, "read_artifact");
    assert.equal(op.isError, true, "默认拒绝跨项目产物读取");
    assert.match(op.resultSummary ?? "", /不属于可读取范围/);

    // 授权 B.artifact → A 后可读
    const grantArt = (await t.client.request<any>("create_data_grant", {
      from_project_id: B, to_project_id: A, category: "artifact",
    })) as any;
    d = await submitAndWait(t, wsA.session.id, "art-ok", "再读产物");
    op = toolOp(d.detail, "read_artifact");
    assert.notEqual(op.isError, true, "授权后可读 B 的产物");
    assert.ok(String(op.resultSummary).includes("紫铜罗盘"));

    // 类别隔离：只给 artifact 不开 history（B 历史里的银杏灯笼不含在授权产物正文中，搜不到）
    d = await submitAndWait(t, wsA.session.id, "art-sep-h", "查历史");
    op = toolOp(d.detail, "history_search");
    assert.match(op.resultSummary ?? "", /命中 0 条/, "只开放 artifact 不开放 history");

    // 方向：B→A 授权不能让 B 读 A 的产物
    d = await submitAndWait(t, wsA.session.id, "art-a-seed", "A产生产物");
    const artA = (d.detail.artifacts as any[]).find((a) => a.name.includes("stdout"));
    assert.ok(artA);
    holder.artA = artA.id;
    d = await submitAndWait(t, wsB.session.id, "art-dir", "B读A产物");
    op = toolOp(d.detail, "read_artifact");
    assert.equal(op.isError, true, "授权有方向：B 读不到 A 的产物");
    assert.match(op.resultSummary ?? "", /不属于可读取范围/);

    // 撤销后拒绝
    await t.client.request("revoke_data_grant", { grant_id: grantArt.id });
    d = await submitAndWait(t, wsA.session.id, "art-final", "末读产物");
    op = toolOp(d.detail, "read_artifact");
    assert.equal(op.isError, true, "撤销后拒绝");
    assert.ok(!String(op.resultSummary).includes("紫铜罗盘"), "撤销后不再读到产物正文");
  } finally {
    await t.shutdown();
  }
});

test("撤销时机：任务运行中撤销授权后，该任务的后续宿主工具查询即被拒绝", async () => {
  const holder = { bSession: "" };
  let phase = 0;
  let secondCallArrived = false;
  let release: (() => void) | null = null;
  const responder: Responder = async (req) => {
    if (lastUserText(req) !== "两段查询") return { kind: "text", text: "好" };
    phase += 1;
    if (phase === 1) {
      return { kind: "tool_calls", calls: [{ id: "q1", name: "history_search", arguments: { query: "青铜灯塔", session_id: holder.bSession } }] };
    }
    if (phase === 2) {
      // 挂起这一次模型调用：测试在挂起期间经控制面撤销授权
      secondCallArrived = true;
      await new Promise<void>((resolve) => { release = resolve; });
      return { kind: "tool_calls", calls: [{ id: "q2", name: "history_search", arguments: { query: "青铜灯塔", session_id: holder.bSession } }] };
    }
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("ws75-revoke-timing", responder);
  try {
    const wsA = await openWorkspace(t, t.work[0]!, "ws75-rt-a");
    const wsB = await openWorkspace(t, t.work[1]!, "ws75-rt-b");
    holder.bSession = wsB.session.id as string;
    await submitAndWait(t, wsB.session.id, "rt-b-seed", "记住暗号：青铜灯塔");
    const grant = (await t.client.request<any>("create_data_grant", {
      from_project_id: wsB.session.projectId as string, to_project_id: wsA.session.projectId as string, category: "history",
    })) as any;

    const taskA = (await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: wsA.session.id, request_id: "rt-a", input: "两段查询",
    })) as any;
    await waitFor("第二次模型调用挂起", () => secondCallArrived);
    // 任务仍在运行：撤销授权后放行后续查询
    await t.client.request("revoke_data_grant", { grant_id: grant.id });
    release!();
    await waitFor("任务终态", async () => (await taskStatus(t.client, taskA.id)).task.status === "completed");
    const detail = await taskStatus(t.client, taskA.id);
    const q1 = opByCallId(detail, "q1");
    const q2 = opByCallId(detail, "q2");
    assert.notEqual(q1.isError, true, "撤销前后台查询成功");
    assert.ok(String(q1.resultSummary).includes("青铜灯塔"), "授权期间读到来源内容");
    assert.equal(q2.isError, true, "撤销后同一任务的后续查询即被拒绝");
    assert.match(q2.resultSummary ?? "", /无权读取/);
  } finally {
    await t.shutdown();
  }
});

test("旧入口兼容与认领：认领后原配置/授权/凭据引用保持可用，旧写入产生同一事件，幂等键重复认领不复制状态", async () => {
  const responder: Responder = async (req) => {
    if (lastUserText(req) === "查X暗号" && !toolRoundDone(req)) {
      return { kind: "tool_calls", calls: [{ id: "hx1", name: "history_search", arguments: { query: "靛蓝榫卯", role: "user" } }] };
    }
    return { kind: "text", text: "好" };
  };
  const t = await startTestRuntime("ws75-legacy", responder);
  try {
    // 旧项目：create_project 无根目录
    const legacy = (await t.client.request<any>("create_project", { name: "老工程" })) as any;
    assert.equal(t.runtime.store.getProject(legacy.id)!.rootDir, null);
    // 旧 CLI 风格写入（不带 expected_version 的兼容写入）
    const saved = (await t.client.request<any>("set_project_instructions", {
      project_id: legacy.id, files: ["LEGACY.md"],
    })) as any;
    assert.equal(saved.settingsVersion, 2);
    const root = t.work[0]!;
    fs.writeFileSync(path.join(root, "LEGACY.md"), "旧项目指令：LEGACY-MARK");

    // 授权来源工作区 X；授权在认领前创建
    const wsX = await openWorkspace(t, t.work[1]!, "ws75-leg-x");
    await submitAndWait(t, wsX.session.id, "leg-x-seed", "X的暗号：靛蓝榫卯");
    const grant = (await t.client.request<any>("create_data_grant", {
      from_project_id: wsX.session.projectId as string, to_project_id: legacy.id, category: "history",
    })) as any;

    // 绑定到旧项目的 MCP 凭据引用
    t.runtime.credentials.upsert({ name: "mcp-cred", host: "mcp.example.com", header: "authorization", purpose: "mcp", secret: "test-secret" });
    await t.client.request("mcp_configure", {
      project_id: legacy.id, name: "docs", endpoint: "https://mcp.example.com/mcp/", credential: "mcp-cred", tool_allowlist: ["a"],
    });
    assert.deepEqual(t.runtime.credentials.get("mcp-cred")!.scope, { projectId: legacy.id, operations: ["mcp"] });

    // open_workspace 以 project_id 认领根目录
    const projectCount = t.runtime.store.listProjects().length;
    const adopted = (await t.client.request<any>("open_workspace", {
      cwd: root, project_id: legacy.id, request_id: "adopt-1",
    })) as any;
    assert.equal(adopted.session.projectId, legacy.id, "认领后新会话归属旧项目");
    assert.equal(adopted.createdProject, false);
    const kept = t.runtime.store.getProject(legacy.id)!;
    const real = fs.realpathSync(root);
    const stat = fs.statSync(real);
    assert.equal(kept.rootDir?.cwdReal, real, "认领根目录");
    assert.deepEqual([kept.rootDir?.dev, kept.rootDir?.ino], [stat.dev, stat.ino]);
    // 原配置与授权保留
    assert.deepEqual(kept.instructionFiles, ["LEGACY.md"], "原指令列表保留");
    assert.equal(kept.settingsVersion, 2, "认领不改设置版本");
    const grants = ((await t.client.request<any>("list_data_grants", {})) as any).grants as any[];
    assert.ok(grants.some((g) => g.id === grant.id && !g.revokedAt), "原资料授权记录保留");

    // 认领后新会话任务：原指令仍按根目录可读
    const before = t.server.calls.length;
    await submitAndWait(t, adopted.session.id, "leg-t1", "开始工作");
    const payload = callPayload(t, before);
    assert.ok(payload.includes("LEGACY-MARK"), "认领后新任务按已确认根目录读原指令");

    // 原授权保持可用：旧项目会话能搜到被授权来源 X 的内容
    const d = await submitAndWait(t, adopted.session.id, "leg-t2", "查X暗号");
    const op = toolOp(d.detail, "history_search");
    assert.ok(String(op.resultSummary).includes("靛蓝榫卯"), "认领后原资料授权保持可用");

    // 旧 CLI 风格写入：settingsVersion 递增且 project.settings_changed 事件出现（控制面断言事件载荷）
    const ws = (await t.client.request<any>("set_project_web_search", { project_id: legacy.id, enabled: false })) as any;
    assert.equal(ws.settingsVersion, 3, "兼容写入递增同一版本");
    const events = settingsEvents(t, legacy.id);
    assert.equal(events.length, 2, "两次成功写入各产生一个设置事件");
    const last = events.at(-1)!.body as any;
    assert.equal(last.projectId, legacy.id);
    assert.equal(last.settingsVersion, 3, "事件携带新设置版本");
    assert.deepEqual(last.instructionFiles, ["LEGACY.md"], "事件携带指令字段（列表，非正文）");
    assert.equal(last.webSearch, "disabled", "事件携带开关字段");
    assert.ok(!("instructions" in last) && !("text" in last), "事件不含指令正文");

    // 幂等键复用的重复 open_workspace：不重复迁移或复制状态
    const again = (await t.client.request<any>("open_workspace", {
      cwd: root, project_id: legacy.id, request_id: "adopt-1",
    })) as any;
    assert.equal(again.session.id, adopted.session.id, "同一请求标识返回原会话");
    assert.equal(again.createdProject, false);
    assert.equal(t.runtime.store.listProjects().length, projectCount, "项目不复制");
    assert.equal(
      t.runtime.store.listSessions().filter((s) => s.createRequestId === "adopt-1").length,
      1,
      "会话不复制",
    );
    assert.equal(
      ((await t.client.request<any>("list_data_grants", {})) as any).grants.length,
      grants.length,
      "授权不复制",
    );
    assert.equal(
      t.runtime.store.getEventsAfter(0).filter((e) => e.body.type === "project.root_attached" && (e.body as any).projectId === legacy.id).length,
      1,
      "认领事件只发一次",
    );
  } finally {
    await t.shutdown();
  }
});

test("凭据 scope 不变式：认领旧项目后，绑定到该项目的 MCP 凭据 scope 不被复制或扩大", async () => {
  const t = await startTestRuntime("ws75-cred-scope", RESPONDER);
  try {
    const legacy = (await t.client.request<any>("create_project", { name: "绑定工程" })) as any;
    t.runtime.credentials.upsert({ name: "mcp-cred", host: "mcp.example.com", header: "authorization", purpose: "mcp", secret: "test-secret" });
    await t.client.request("mcp_configure", {
      project_id: legacy.id, name: "docs", endpoint: "https://mcp.example.com/mcp/", credential: "mcp-cred", tool_allowlist: ["a"],
    });
    const scopeBefore = t.runtime.credentials.get("mcp-cred")!.scope;
    assert.deepEqual(scopeBefore, { projectId: legacy.id, operations: ["mcp"] }, "配置后凭据 scope 收紧到旧项目");

    await t.client.request("open_workspace", { cwd: t.work[0]!, project_id: legacy.id, request_id: "cred-adopt" });

    const list = (await t.client.request<any>("list_credentials", {})) as any[];
    assert.equal(list.length, 1, "凭据绑定不被复制");
    assert.equal(list[0]!.name, "mcp-cred");
    assert.ok(!JSON.stringify(list).includes("test-secret"), "凭据列表不含秘密值");
    assert.deepEqual(t.runtime.credentials.get("mcp-cred")!.scope, scopeBefore, "认领不改写凭据 scope");
    assert.ok(
      t.runtime.credentials.getForUse("mcp-cred", { projectId: legacy.id, operation: "mcp" }),
      "原项目仍可使用凭据",
    );
    assert.equal(
      t.runtime.credentials.getForUse("mcp-cred", { projectId: "proj_other", operation: "mcp" }),
      null,
      "凭据 scope 未扩大到其他项目",
    );
    const services = ((await t.client.request<any>("mcp_list", {})) as any).services as any[];
    assert.equal(services.length, 1, "MCP 服务仍一条");
    assert.equal(services[0]!.projectId, legacy.id, "MCP 服务归属不变");
  } finally {
    await t.shutdown();
  }
});

test("store：updateProjectSettings 同值保存幂等（不递增版本、不产生事件），改动保存递增并发事件", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-ws75-store-"));
  const db = new Db(dataDir);
  try {
    const store = new Store(db);
    const project = store.withTx(() => store.createProject("夹具项目"));
    const events = () => store.getEventsAfter(0).filter((e) => e.body.type === "project.settings_changed");

    const same = store.withTx(() =>
      store.updateProjectSettings({ projectId: project.id, instructionFiles: [], webSearch: "enabled" }),
    );
    assert.equal(same.settingsVersion, 1, "同值保存不递增版本");
    assert.equal(events().length, 0, "同值保存不产生事件");

    const changed = store.withTx(() => store.updateProjectSettings({ projectId: project.id, instructionFiles: ["TEAM.md"] }));
    assert.equal(changed.settingsVersion, 2, "改动保存递增版本");
    assert.equal(events().length, 1, "改动保存产生事件");
    const event = events()[0]!.body as any;
    assert.equal(event.projectId, project.id);
    assert.equal(event.settingsVersion, 2);
    assert.deepEqual(event.instructionFiles, ["TEAM.md"]);
    assert.equal(event.webSearch, "enabled", "事件携带当前配置字段");
    assert.ok(!("instructions" in event) && !("text" in event), "事件不含指令正文");

    const again = store.withTx(() =>
      store.updateProjectSettings({ projectId: project.id, instructionFiles: ["TEAM.md"], webSearch: "enabled" }),
    );
    assert.equal(again.settingsVersion, 2, "重复同值保存仍幂等");
    assert.equal(events().length, 1, "重复同值保存不再发事件");

    const web = store.withTx(() => store.updateProjectSettings({ projectId: project.id, webSearch: "disabled" }));
    assert.equal(web.settingsVersion, 3, "开关改动递增版本");
    assert.equal(events().length, 2, "开关改动产生事件");
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
