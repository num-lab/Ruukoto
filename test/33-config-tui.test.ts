/**
 * 配置中心 TUI 集成（issue 21 §3）：假 Terminal + 真实后台/控制协议。
 *
 * 覆盖：
 * 1. 在线：导航到「模型与提供方」设置后台默认模型，经控制面核实落库；
 * 2. 在线：API key 经遮蔽输入写入 auth.json（0600、秘密不进终端输出）；
 * 3. 在线：修订冲突时提示「已重新加载」并刷新出新数据；
 * 4. 离线：后台持有配置锁时拒绝进入；独立目录可写 key/默认模型且退出后释放锁；
 * 5. 重载状态：导航分区持久化、重启恢复、损坏文件提示后回主菜单；
 * 6. 工作区设置入口（agent-direction issue 06 步骤 3）：ruukoto-dev 的项目分区按
 *    工作区/旧项目分类（ruukoto 不标注）、工作区详情内 MCP 固定归属、设置冲突
 *    重读后台、资料授权方向/同范围/已撤销、重载恢复沿用既有菜单 id；
 *    mcp_remove 的可选期望版本在协议层验证（CLI --expected-version 为同形透传）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Terminal } from "@earendil-works/pi-tui";
import { readOwnerToken } from "../src/control/owner-token.ts";
import { acquireConfigLock } from "../src/core/instance-lock.ts";
import { runConfigTui } from "../src/config-tui/index.ts";
import { ConfigTuiApp } from "../src/config-tui/app.ts";
import { OfflineModelBackend } from "../src/config-tui/index.ts";
import type { Session } from "../src/core/types.ts";
import {
  startTestRuntime,
  createProjectSession,
  makeTestDirs,
  cleanupDirs,
  writeModelsJson,
  waitFor,
  type TestRuntime,
} from "./helpers/testkit.ts";

// ---------- 假终端（与 test/14 同一形态：send 模拟 StdinBuffer 分帧） ----------

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 30;
  readonly kittyProtocolActive = false;
  private written: string[] = [];
  private onInput: ((data: string) => void) | null = null;
  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  /** 与 ProcessTerminal 一致：括号粘贴整段作为一次输入送达。 */
  paste(text: string): void {
    this.onInput?.(`\x1b[200~${text}\x1b[201~`);
  }
  send(data: string): void {
    let textBuf = "";
    const flush = () => {
      if (textBuf) {
        this.onInput?.(textBuf);
        textBuf = "";
      }
    };
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        flush();
        const rest = data.slice(i);
        const m = /^\x1b\[[A-Za-z]~?/.exec(rest) ?? /^\x1b./.exec(rest);
        const seq = m ? m[0] : "\x1b";
        this.onInput?.(seq);
        i += seq.length - 1;
      } else if (ch === "\r" || ch === "\n" || ch === "\x03" || ch === "\t") {
        flush();
        this.onInput?.(ch);
      } else {
        textBuf += ch;
      }
    }
    flush();
  }
  output(): string {
    return this.written.join("");
  }
  clearOutput(): void {
    this.written = [];
  }
}

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_C = "\x03";

interface ConfigHarness {
  terminal: FakeTerminal;
  done: Promise<number>;
  /** 退出并等待收尾（重复调用安全）。 */
  quit(): Promise<number>;
}

async function waitForText(term: FakeTerminal, text: string, desc = text, timeoutMs?: number): Promise<void> {
  await waitFor(`屏幕出现「${desc}」`, () => term.output().includes(text), timeoutMs);
}

function startConfig(t: TestRuntime, opts: { offline?: boolean; product?: "ruukoto" | "ruukoto-dev" } = {}): ConfigHarness {
  const terminal = new FakeTerminal();
  const done = runConfigTui({
    offline: opts.offline,
    terminal,
    connect: { socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! },
    agentDir: t.dirs.agentDir,
    product: opts.product,
  });
  return {
    terminal,
    done,
    quit: async () => {
      terminal.send(CTRL_C);
      return done;
    },
  };
}

const textResponder = async () => ({ kind: "text", text: "ok" }) as any;

// ---------- 测试 ----------

test("在线：会话默认列表含 Plan，Esc 取消不保存，选择后持久化并在重新进入时显示", async () => {
  const t = await startTestRuntime("cfg-tui-plan", textResponder);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!, { projectName: "Plan测试" });
    const sessionIndex = t.runtime.store.listSessions().findIndex((s) => s.id === sessionId);
    const h = startConfig(t);
    try {
      await waitForText(h.terminal, "配置分区");
      h.terminal.send(DOWN + DOWN + ENTER);
      await waitForText(h.terminal, "Plan测试");
      h.terminal.send(DOWN.repeat(sessionIndex) + ENTER);
      await waitForText(h.terminal, "默认模式：请求确认");
      h.terminal.send(DOWN + ENTER);
      await waitForText(h.terminal, "Plan（持续调研和完善计划，固定自动审查");
      h.terminal.send(ESC);
      assert.equal((await t.client.request<Session>("get_session", { session_id: sessionId })).defaultAccessModeVersion, 0);
      h.terminal.clearOutput();
      h.terminal.send(ENTER);
      await waitForText(h.terminal, "会话默认模式（新建任务使用）");
      h.terminal.send(DOWN + DOWN + DOWN + ENTER);
      await waitForText(h.terminal, "会话默认模式已保存");
      const saved = await t.client.request<Session>("get_session", { session_id: sessionId });
      assert.equal(saved.defaultAccessMode, "plan");
      assert.equal(saved.defaultAccessModeVersion, 1);
    } finally {
      await h.quit();
    }
    const reopened = startConfig(t);
    try {
      await waitForText(reopened.terminal, "配置分区");
      reopened.terminal.send(DOWN + DOWN + ENTER);
      await waitForText(reopened.terminal, "Plan测试");
      reopened.terminal.send(DOWN.repeat(sessionIndex) + ENTER);
      await waitForText(reopened.terminal, "默认模式：Plan");
    } finally {
      await reopened.quit();
    }
  } finally {
    await t.shutdown();
  }
});

test("配置中心按后台身份仅向普通开发会话提供 Plan，main、SubAgent 和归档不提供", async () => {
  const t = await startTestRuntime("cfg-tui-plan-identity", textResponder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const store = t.runtime.store;
    const create = async () => t.client.request<Session>("create_session", { project_id: projectId, cwd: t.work[0]! });
    const main = store.getSession(store.getAgentRole("main")!.sessionId)!;
    const sub = await create();
    store.insertSubAgent({ id: "sub-mode", parentSessionId: sessionId, sessionId: sub.id, workDir: sub.cwd, activeWorkId: null, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: sub.createdAt });
    const archive = await create();
    store.db.prepare("UPDATE sessions SET kind = 'qq_group' WHERE id = ?").run(archive.id);
    const snapshot = (await t.client.handshake()).snapshot;
    const app = new ConfigTuiApp({ mode: "online", modelBackend: new OfflineModelBackend(t.dirs.agentDir), agentDir: t.dirs.agentDir, client: t.client, snapshot, terminal: new FakeTerminal(), onExit: () => {} }) as any;
    let values: string[] = [];
    app.pick = async (_title: string, items: Array<{ value: string }>) => { values = items.map((item) => item.value); return null; };
    for (const [id, eligible] of [[sessionId, true], [main.id, false], [sub.id, false], [archive.id, false]] as const) {
      await app.sessionScreen(id).onSelect({ value: "mode" });
      assert.equal(values.includes("plan"), eligible, id);
      assert.equal(values.length, eligible ? 4 : 3);
    }
    app.refresh = async () => {};
    for (const [mode, version] of [["plan", 1], ["plan", 1], ["full_access", 2]] as const) {
      app.pick = async () => mode;
      await app.sessionScreen(sessionId).onSelect({ value: "mode" });
      const saved = await t.client.request<Session>("get_session", { session_id: sessionId });
      const local = app.sessions.find((s: Session) => s.id === sessionId)!;
      assert.equal(saved.defaultAccessMode, mode);
      assert.equal(saved.defaultAccessModeVersion, version);
      assert.equal(local.defaultAccessMode, saved.defaultAccessMode);
      assert.equal(local.defaultAccessModeVersion, version, "选中现有 Plan 不递增版本，界面保存后台返回的实际版本");
    }
  } finally {
    await t.shutdown();
  }
});

test("在线：设置后台默认模型并经控制面核实", async () => {
  const t = await startTestRuntime("cfg-tui-default", textResponder);
  try {
    const h = startConfig(t);
    try {
      await waitForText(h.terminal, "配置分区");
      h.terminal.send(ENTER); // 模型与提供方
      await waitForText(h.terminal, "设置后台默认模型");
      h.terminal.send(DOWN); // provider:mock → 设置后台默认模型
      h.terminal.send(ENTER);
      await waitForText(h.terminal, "后台默认模型：提供方");
      h.terminal.send(ENTER); // mock
      await waitForText(h.terminal, "后台默认模型：模型");
      h.terminal.send(ENTER); // mock-model
      await waitForText(h.terminal, "后台默认模型：思考档位");
      h.terminal.send(ENTER); // off
      await waitForText(h.terminal, "后台默认模型已保存");
      const view = await t.client.request<any>("get_model_config", {});
      assert.deepEqual(view.defaultModel, { provider: "mock", modelId: "mock-model", thinkingLevel: "off" });
    } finally {
      assert.equal(await h.quit(), 0);
    }
  } finally {
    await t.shutdown();
  }
});

test("在线：API key 遮蔽输入写入 auth.json，秘密不进终端输出", async () => {
  const t = await startTestRuntime("cfg-tui-apikey", textResponder);
  const secret = "sk-test-abcdef123456";
  try {
    const h = startConfig(t);
    try {
      await waitForText(h.terminal, "配置分区");
      h.terminal.send(ENTER); // 模型与提供方
      await waitForText(h.terminal, "设置后台默认模型");
      h.terminal.send(ENTER); // provider:mock
      await waitForText(h.terminal, "提供方 mock");
      h.terminal.send(DOWN + DOWN + DOWN + DOWN + DOWN); // → API key
      h.terminal.send(ENTER);
      await waitForText(h.terminal, "设置/更新 API key");
      h.terminal.send(ENTER); // 设置/更新
      await waitForText(h.terminal, "显示为");
      h.terminal.paste(secret.slice(0, 10)); // 粘贴 + 逐字输入两条路径
      h.terminal.send(secret.slice(10));
      h.terminal.send(ENTER);
      await waitForText(h.terminal, "API key 已保存");

      const authFile = path.join(t.dirs.agentDir, "auth.json");
      const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
      assert.deepEqual(auth.mock, { type: "api_key", key: secret }, "key 必须 0600 持久化到 auth.json");
      assert.equal(fs.statSync(authFile).mode & 0o777, 0o600, "auth.json 权限必须是 0600");
      assert.ok(!h.terminal.output().includes(secret), "秘密值不得出现在终端输出");
      const view = await t.client.request<any>("get_model_config", {});
      assert.equal(view.credentials.mock?.configured, true, "控制面视图应报已配置");
    } finally {
      assert.equal(await h.quit(), 0);
    }
  } finally {
    await t.shutdown();
  }
});

test("在线：修订冲突提示重新加载并刷新出新数据", async () => {
  const t = await startTestRuntime("cfg-tui-conflict", textResponder);
  try {
    // B（另一客户端，先于界面）：陈旧修订必须被拒绝
    const b1 = await t.client.request<any>("get_model_config", {});
    await t.client.request("set_model_api_key", { provider: "mock", api_key: "conflict-key-b", expected_revision: b1.revision });
    const b2 = await t.client.request<any>("get_model_config", {});
    const providersB = JSON.parse(JSON.stringify(b2.providers));
    delete providersB.mock.apiKey; // 脱敏占位符（凭据已在 auth.json，可安全移除内联字段）
    await t.client.request("save_model_catalog", { providers: providersB, expected_revision: b2.revision });
    await assert.rejects(
      () => t.client.request("save_model_catalog", { providers: providersB, expected_revision: b1.revision }),
      (err: any) => err?.code === "config_conflict",
      "陈旧修订必须被后台拒绝",
    );

    // A 的界面读到 R3；此后未经事件的外部改写（修订指纹按文件字节计算，
    // 正是它要兜住的场景）使 A 的下次保存必然冲突
    const h = startConfig(t);
    try {
      await waitForText(h.terminal, "配置分区");
      h.terminal.send(ENTER);
      await waitForText(h.terminal, "设置后台默认模型");
      h.terminal.send(ENTER);
      await waitForText(h.terminal, "提供方 mock");

      const modelsFile = path.join(t.dirs.agentDir, "models.json");
      const catalog = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
      catalog.providers.mock.name = "Mock 改版";
      fs.writeFileSync(modelsFile, JSON.stringify(catalog, null, 2));

      // A 用陈旧修订保存：不输入直接提交名称字段 → config_conflict → 重新加载
      h.terminal.send(ENTER); // field:name
      await waitForText(h.terminal, "mock 的 名称");
      h.terminal.send(ENTER); // 提交原值
      await waitForText(h.terminal, "配置已被其他客户端修改，已重新加载");
      await waitForText(h.terminal, "Mock 改版", "刷新后的新名称");
    } finally {
      assert.equal(await h.quit(), 0);
    }
  } finally {
    await t.shutdown();
  }
});

test("离线：后台持有配置锁时拒绝进入，并打印占用说明", async () => {
  const t = await startTestRuntime("cfg-tui-lock", textResponder);
  try {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await runConfigTui({
        offline: true,
        terminal: new FakeTerminal(),
        connect: { socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! },
        agentDir: t.dirs.agentDir,
      });
    } finally {
      console.error = origError;
    }
    assert.equal(code!, 1);
    assert.ok(
      errors.some((line) => line.includes("配置目录正被后台或另一配置进程占用")),
      `占用提示缺失：${errors.join("\n")}`,
    );
    assert.ok(errors.some((line) => line.includes("socket 不可达不能证明后台已停")), "须明示 socket 不可达不代表后台已停");
  } finally {
    await t.shutdown();
  }
});

test("离线：独立目录写 key 与默认模型，退出释放配置锁", async () => {
  const { dirs } = await makeTestDirs("cfg-tui-offline", 0);
  const secret = "offline-secret-key";
  try {
    await writeModelsJson(dirs, "http://127.0.0.1:1");
    const terminal = new FakeTerminal();
    const done = runConfigTui({ offline: true, terminal, agentDir: dirs.agentDir });
    const quit = async () => {
      terminal.send(CTRL_C);
      return done;
    };
    try {
      await waitForText(terminal, "配置分区（离线模式：仅模型配置可写）");
      // 非模型分区在离线模式不可用
      terminal.send(DOWN); // 项目
      terminal.send(ENTER);
      await waitForText(terminal, "该分区需要连接后台");
      // API key
      terminal.send("\x1b[A"); // 回 模型与提供方
      terminal.send(ENTER);
      await waitForText(terminal, "设置后台默认模型");
      terminal.send(ENTER); // provider:mock
      await waitForText(terminal, "提供方 mock");
      terminal.send(DOWN + DOWN + DOWN + DOWN + DOWN); // → API key
      terminal.send(ENTER);
      await waitForText(terminal, "设置/更新 API key");
      terminal.send(ENTER);
      await waitForText(terminal, "显示为");
      terminal.send(secret);
      terminal.send(ENTER);
      await waitForText(terminal, "API key 已保存");
      // 默认模型：返回上一层后进入 picker
      terminal.send(ESC); // 回模型与提供方
      await waitForText(terminal, "新增提供方");
      terminal.send(DOWN); // → 设置后台默认模型
      terminal.send(ENTER);
      await waitForText(terminal, "后台默认模型：提供方");
      terminal.send(ENTER);
      await waitForText(terminal, "后台默认模型：模型");
      terminal.send(ENTER);
      await waitForText(terminal, "后台默认模型：思考档位");
      terminal.send(ENTER);
      await waitForText(terminal, "后台默认模型已保存");
      assert.ok(!terminal.output().includes(secret), "秘密值不得出现在终端输出");
    } finally {
      assert.equal(await quit(), 0);
    }
    const auth = JSON.parse(fs.readFileSync(path.join(dirs.agentDir, "auth.json"), "utf8"));
    assert.deepEqual(auth.mock, { type: "api_key", key: secret });
    const def = JSON.parse(fs.readFileSync(path.join(dirs.agentDir, "default-model.json"), "utf8"));
    assert.deepEqual(def, { provider: "mock", modelId: "mock-model", thinkingLevel: "off" });
    assert.equal(fs.statSync(path.join(dirs.agentDir, "default-model.json")).mode & 0o777, 0o600);
    const lock = acquireConfigLock(dirs.agentDir); // 退出后锁必须已释放
    lock.release();
  } finally {
    await cleanupDirs(dirs);
  }
});

test("离线：设置摘要模型（issue 30），页头显示数据去向与所选模型", async () => {
  const { dirs } = await makeTestDirs("cfg-tui-summary", 0);
  try {
    await writeModelsJson(dirs, "http://127.0.0.1:1");
    const terminal = new FakeTerminal();
    const done = runConfigTui({ offline: true, terminal, agentDir: dirs.agentDir });
    try {
      await waitForText(terminal, "配置分区（离线模式：仅模型配置可写）");
      terminal.send(ENTER); // 模型与提供方
      await waitForText(terminal, "摘要模型：未设置（用会话当前模型）");
      terminal.send(DOWN + DOWN); // provider:mock → 设置后台默认模型 → 设置摘要模型
      terminal.send(ENTER);
      await waitForText(terminal, "摘要模型：提供方");
      assert.ok(terminal.output().includes("会发给该模型的提供方做摘要"), "说明数据去向");
      terminal.send(DOWN); // 不设置 → mock
      terminal.send(ENTER);
      await waitForText(terminal, "摘要模型：模型");
      terminal.send(ENTER);
      await waitForText(terminal, "摘要模型已保存：mock/mock-model");
      await waitForText(terminal, "摘要模型：mock/mock-model");
    } finally {
      terminal.send(CTRL_C);
      assert.equal(await done, 0);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.agentDir, "summary-model.json"), "utf8")), { provider: "mock", modelId: "mock-model" });
  } finally {
    await cleanupDirs(dirs);
  }
});

test("重载状态：分区路径持久化与恢复，损坏文件提示后回主菜单", async () => {
  const t = await startTestRuntime("cfg-tui-reload", textResponder);
  const stateDir = await mkdtemp(path.join(tmpdir(), "ruukoto-cfg-reload-"));
  const stateFile = path.join(stateDir, "reload.json");
  const envKey = "RUUKOTO_RELOAD_STATE_FILE";
  const origEnv = process.env[envKey];
  process.env[envKey] = stateFile;
  try {
    // 第一次：模型与提供方 → 提供方 mock → 模型列表后退出，分区路径应落盘
    // （模型列表屏幕由 value 为 models 的条目打开，id 必须与之一致才能恢复）
    const h1 = startConfig(t);
    try {
      await waitForText(h1.terminal, "配置分区");
      h1.terminal.send(ENTER);
      await waitForText(h1.terminal, "设置后台默认模型");
      h1.terminal.send(ENTER); // provider:mock
      await waitForText(h1.terminal, "提供方 mock");
      h1.terminal.send(DOWN + DOWN + DOWN + DOWN + ENTER); // → 模型列表
      await waitForText(h1.terminal, "新增模型");
      await waitFor("重载状态落盘", () => {
        try {
          const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          return s.kind === "config-tui" && JSON.stringify(s.section) === JSON.stringify(["models", "provider:mock", "models"]);
        } catch {
          return false;
        }
      });
    } finally {
      assert.equal(await h1.quit(), 0);
    }

    // 第二次：同一实例重启，逐层恢复到模型列表
    const h2 = startConfig(t);
    try {
      await waitForText(h2.terminal, "新增模型", "恢复后直接进入提供方的模型列表");
      assert.ok(!h2.terminal.output().includes("已不存在"), "不得误报分区不存在");
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.equal(state.instanceId.length > 0, true);
    } finally {
      assert.equal(await h2.quit(), 0);
    }

    // 损坏文件：提示后从主菜单开始
    fs.writeFileSync(stateFile, "{ 这不是合法 JSON");
    const h3 = startConfig(t);
    try {
      await waitForText(h3.terminal, "重载状态文件无效，已从主菜单开始");
      await waitForText(h3.terminal, "服务凭据");
    } finally {
      assert.equal(await h3.quit(), 0);
    }
  } finally {
    if (origEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = origEnv;
    await rm(stateDir, { recursive: true, force: true });
    await t.shutdown();
  }
});

// ---------- agent-direction issue 06 步骤 3：工作区设置入口 ----------

const UP = "\x1b[A";

test("ruukoto-dev：项目分区先列工作区（显示根目录）再列旧项目；ruukoto 不标注", async () => {
  const t = await startTestRuntime("cfg-tui-ws-partition", textResponder);
  try {
    const ws = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "ws-part-1" })) as any;
    const legacy = (await t.client.request<any>("create_project", { name: "legacy-plain" })) as any;
    await t.client.request("create_session", { project_id: legacy.id, cwd: t.work[1]! });
    const rootReal = fs.realpathSync(t.work[0]!);

    const hDev = startConfig(t, { product: "ruukoto-dev" });
    try {
      await waitForText(hDev.terminal, "配置分区");
      hDev.terminal.send(DOWN + ENTER); // 项目
      await waitForText(hDev.terminal, "旧项目 · legacy-plain");
      const out = hDev.terminal.output();
      assert.ok(out.includes(`工作区 · ${ws.projectName}`), "工作区标注");
      // 描述行按终端宽度截断：断言根目录前缀片段（完整 cwdReal 在数据层，见项目管理屏幕 intro）
      assert.ok(out.includes(`根目录 ${rootReal.slice(0, 40)}`), "工作区展示根目录");
      assert.ok(
        out.lastIndexOf(`工作区 · ${ws.projectName}`) < out.lastIndexOf("旧项目 · legacy-plain"),
        "工作区排在旧项目之前",
      );
      // 菜单 id 沿用 project:<id>（重载恢复按 value 匹配，不因标注改变形状）
      assert.ok(!out.includes("workspace:"), "不引入新的菜单 id");
    } finally {
      assert.equal(await hDev.quit(), 0);
    }

    // ruukoto：既有项目列表行为，不标工作区/旧项目
    const hStd = startConfig(t, { product: "ruukoto" });
    try {
      await waitForText(hStd.terminal, "配置分区");
      hStd.terminal.send(DOWN + ENTER);
      await waitForText(hStd.terminal, "legacy-plain");
      const out = hStd.terminal.output();
      assert.ok(!out.includes("工作区 ·"), "ruukoto 不标工作区");
      assert.ok(!out.includes("旧项目 ·"), "ruukoto 不标旧项目");
      assert.ok(!out.includes(`根目录 ${rootReal.slice(0, 40)}`), "ruukoto 分区不展示根目录前缀");
    } finally {
      assert.equal(await hStd.quit(), 0);
    }
  } finally {
    await t.shutdown();
  }
});

test("ruukoto-dev：工作区详情的 MCP 只列本项目服务，新增固定归属且跳过项目选择；全局入口仍按分类选择", async () => {
  const t = await startTestRuntime("cfg-tui-ws-mcp", textResponder);
  try {
    const a = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "ws-mcp-a" })) as any;
    const b = (await t.client.request<any>("open_workspace", { cwd: t.work[1]!, request_id: "ws-mcp-b" })) as any;
    const projectA = a.session.projectId as string;
    const projectB = b.session.projectId as string;
    await t.client.request("mcp_configure", {
      project_id: projectA, name: "docs", endpoint: "https://docs.example.com/mcp", tool_allowlist: ["search"],
    });
    await t.client.request("mcp_configure", {
      project_id: projectB, name: "otherb", endpoint: "https://b.example.com/mcp", tool_allowlist: [],
    });

    const h = startConfig(t, { product: "ruukoto-dev" });
    try {
      await waitForText(h.terminal, "配置分区");
      h.terminal.send(DOWN + ENTER); // 项目
      await waitForText(h.terminal, `工作区 · ${a.projectName}`);
      h.terminal.send(ENTER); // 工作区 A（首个工作区）
      await waitForText(h.terminal, "指令文件：");
      h.terminal.send(DOWN + DOWN + DOWN + ENTER); // instructions/websearch/jev → MCP 服务
      await waitForText(h.terminal, "固定归属项目");
      assert.ok(h.terminal.output().includes("docs"), "本项目服务在列表中");
      assert.ok(!h.terminal.output().includes("otherb"), "其他工作区的服务不出现在本项目列表");

      // 详情内新增：跳过「所属项目」选择，固定归属本项目
      h.terminal.send(DOWN + ENTER); // docs → 新增服务
      await waitForText(h.terminal, "服务名");
      h.terminal.send("svcnew" + ENTER);
      await waitForText(h.terminal, "端点 URL");
      h.terminal.send("https://c.example.com/mcp" + ENTER);
      await waitForText(h.terminal, "凭据引用名");
      h.terminal.send(ENTER); // 无凭据
      await waitForText(h.terminal, "工具允许列表");
      h.terminal.send("fetch" + ENTER);
      await waitForText(h.terminal, "MCP 服务已创建");
      assert.ok(!h.terminal.output().includes("所属项目"), "详情内新增不再选择项目");
      const listA = (await t.client.request<any>("mcp_list", { project_id: projectA })) as any;
      const svcNew = (listA.services as any[]).find((s) => s.name === "svcnew");
      assert.ok(svcNew, "新增服务固定归属本项目");
      assert.equal(svcNew.endpoint, "https://c.example.com/mcp");
      const listB = (await t.client.request<any>("mcp_list", { project_id: projectB })) as any;
      assert.deepEqual((listB.services as any[]).map((s) => s.name), ["otherb"], "B 项目未被串改");

      // 启停携带期望版本：当前版本停用成功
      h.terminal.send(UP + UP + ENTER); // add → svc:svcnew → svc:docs
      await waitForText(h.terminal, "停用该服务");
      h.terminal.send(DOWN + DOWN + DOWN + ENTER);
      await waitForText(h.terminal, "服务已停用");
      const docsAfter = ((await t.client.request<any>("mcp_list", { project_id: projectA })) as any).services.find((s: any) => s.name === "docs");
      assert.equal(docsAfter.enabled, false, "启停经控制面生效");

      // 回到根菜单进入全局 MCP：列出全部服务，新增仍按工作区/旧项目分类选择项目
      h.terminal.send(ESC); // → 项目 MCP 列表
      await waitForText(h.terminal, "固定归属项目");
      h.terminal.send(ESC); // → 项目详情
      await waitForText(h.terminal, "资料授权");
      h.terminal.send(ESC); // → 项目分区
      await waitForText(h.terminal, `工作区 · ${a.projectName}`);
      h.terminal.send(ESC); // → 根菜单
      await waitForText(h.terminal, "服务凭据");
      h.terminal.send(DOWN + DOWN + DOWN + ENTER); // → 全局 MCP 服务
      await waitForText(h.terminal, `docs（${a.projectName}）`);
      assert.ok(h.terminal.output().includes(`otherb（${b.projectName}）`), "全局入口列出全部项目的服务");
      h.terminal.send(DOWN + DOWN + DOWN + ENTER); // 3 个服务 → 新增服务
      await waitForText(h.terminal, "所属项目");
      assert.ok(h.terminal.output().includes(`工作区 · ${a.projectName}`), "全局新增的项目选择沿用工作区/旧项目标注");
      h.terminal.send(ESC); // 取消项目选择
    } finally {
      assert.equal(await h.quit(), 0);
    }
  } finally {
    await t.shutdown();
  }
});

test("ruukoto-dev：设置编辑期另一客户端保存后，本界面旧表单保存冲突并重读后台展示新值", async () => {
  const t = await startTestRuntime("cfg-tui-ws-conflict", textResponder);
  try {
    const a = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "ws-conflict-1" })) as any;
    const projectId = a.session.projectId as string;
    const h = startConfig(t, { product: "ruukoto-dev" });
    try {
      await waitForText(h.terminal, "配置分区");
      h.terminal.send(DOWN + ENTER);
      await waitForText(h.terminal, `工作区 · ${a.projectName}`);
      h.terminal.send(ENTER);
      await waitForText(h.terminal, "指令文件：");
      h.terminal.send(ENTER); // 打开指令编辑框（此时表单版本 v1）
      await waitForText(h.terminal, "项目指令文件");
      // 第二个控制面客户端在表单打开期间保存同一项目的指令（v1 → v2）
      await t.client.request("set_project_instructions", { project_id: projectId, files: ["OTHER.md"], expected_version: 1 });
      h.terminal.send("MINE.md" + ENTER); // 旧表单（v1）提交 → 冲突
      await waitForText(h.terminal, "配置已被其他客户端修改，已重新加载");
      await waitForText(h.terminal, "OTHER.md", "重读后台后的新值");
      assert.ok(!h.terminal.output().includes("指令文件：MINE.md"), "旧表单提交未生效");
      assert.deepEqual(t.runtime.store.getProject(projectId)!.instructionFiles, ["OTHER.md"], "后台值未被旧表单覆盖");

      // 重读后版本已刷新：用 Web Search 开关立即再保存成功（v2 → v3；未变更的保存按设计是 no-op）
      h.terminal.send(DOWN + ENTER); // → Web Search
      await waitForText(h.terminal, "Web Search 开关");
      h.terminal.send(DOWN + ENTER); // → 禁用
      await waitForText(h.terminal, "Web Search 已禁用", "重读后保存成功");
      assert.equal(t.runtime.store.getProject(projectId)!.webSearch, "disabled");
      assert.equal(t.runtime.store.getProject(projectId)!.settingsVersion, 3, "冲突重读后的版本可继续保存");
    } finally {
      assert.equal(await h.quit(), 0);
    }
  } finally {
    await t.shutdown();
  }
});

test("ruukoto-dev：资料授权标注出向/入向；同范围多条撤销提示不夸大；撤销后可在已撤销记录查看", async () => {
  const t = await startTestRuntime("cfg-tui-ws-grants", textResponder);
  try {
    const pa = (await t.client.request<any>("create_project", { name: "alpha-g" })) as any;
    const pb = (await t.client.request<any>("create_project", { name: "beta-g" })) as any;
    await t.client.request("create_data_grant", { from_project_id: pa.id, to_project_id: pb.id, category: "history", purpose: "第一条历史授权" });
    await t.client.request("create_data_grant", { from_project_id: pa.id, to_project_id: pb.id, category: "history", purpose: "第二条历史授权" });
    await t.client.request("create_data_grant", { from_project_id: pb.id, to_project_id: pa.id, category: "memory" });
    const preRevoked = (await t.client.request<any>("create_data_grant", { from_project_id: pa.id, to_project_id: pb.id, category: "artifact" })) as any;
    await t.client.request("revoke_data_grant", { grant_id: preRevoked.id });

    const h = startConfig(t, { product: "ruukoto-dev" });
    try {
      await waitForText(h.terminal, "配置分区");
      h.terminal.send(DOWN + ENTER); // 项目
      await waitForText(h.terminal, "旧项目 · alpha-g");
      h.terminal.send(ENTER); // alpha（旧项目第一个）
      await waitForText(h.terminal, "指令文件：");
      h.terminal.send(DOWN + DOWN + DOWN + DOWN + ENTER); // → 资料授权
      await waitForText(h.terminal, "出向");
      const listing = h.terminal.output();
      assert.ok(listing.includes("入向"), "B→A 的记忆授权标注入向");
      assert.ok(listing.includes("第一条历史授权") && listing.includes("第二条历史授权"), "同范围两条授权逐条显示");

      // 撤销同范围两条中的一条：确认与完成提示都明确该类访问仍开放
      // （确认前有一次 list_data_grants 重读；全量并行负载下放宽等待预算）
      h.terminal.send(ENTER); // 第一条（index 0）
      await waitForText(h.terminal, "同范围还有 1 条有效授权，撤销本条后该类访问仍开放", "撤销确认提示", 60_000);
      h.terminal.send(ENTER); // 确认
      await waitForText(h.terminal, "授权已撤销；同范围还有 1 条有效授权，该类访问仍开放", "撤销完成提示", 60_000);
      assert.ok(!h.terminal.output().includes("访问已全部关闭") && !h.terminal.output().includes("已关闭对该类的全部访问"), "撤销一条不描述为关闭全部访问");

      // 新建授权：方向固定 = 当前项目 → 所选目标
      h.terminal.send(DOWN + DOWN + ENTER); // grant2/入向 → 新建授权
      await waitForText(h.terminal, "授权目标项目");
      assert.ok(h.terminal.output().includes("旧项目 · beta-g"), "目标选择沿用工作区/旧项目标注");
      h.terminal.send(ENTER); // beta-g
      await waitForText(h.terminal, "资料类别");
      h.terminal.send(DOWN + ENTER); // 产物
      await waitForText(h.terminal, "用途说明");
      h.terminal.send(ENTER); // 留空
      await waitForText(h.terminal, "授权已创建");
      const all = (await t.client.request<any>("list_data_grants", {})) as any;
      const activeArtifact = (all.grants as any[]).filter(
        (g) => g.revokedAt === null && g.fromProjectId === pa.id && g.toProjectId === pb.id && g.category === "artifact",
      );
      assert.equal(activeArtifact.length, 1, "新建授权方向固定为当前项目 → 所选目标");

      // 已撤销记录：含本次撤销的历史授权与预置撤销的产物授权，含撤销时间
      h.terminal.send(DOWN + ENTER); // 新建授权 → 查看已撤销
      await waitForText(h.terminal, "已撤销的资料授权");
      const revokedView = h.terminal.output();
      assert.ok(revokedView.includes("alpha-g → beta-g · 历史 · 撤销于"), "刚撤销的授权出现在已撤销记录（含撤销时间）");
      assert.ok(revokedView.includes("alpha-g → beta-g · 产物 · 撤销于"), "预置撤销的授权也在记录中");
      h.terminal.send(ESC); // 关闭只读记录
    } finally {
      assert.equal(await h.quit(), 0);
    }
  } finally {
    await t.shutdown();
  }
});

test("重载恢复：项目 → 某项目 → MCP 沿用既有 id 序列持久化并恢复", async () => {
  const t = await startTestRuntime("cfg-tui-ws-reload", textResponder);
  const stateDir = await mkdtemp(path.join(tmpdir(), "ruukoto-cfg-ws-reload-"));
  const stateFile = path.join(stateDir, "reload.json");
  const envKey = "RUUKOTO_RELOAD_STATE_FILE";
  const origEnv = process.env[envKey];
  process.env[envKey] = stateFile;
  try {
    const a = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "ws-reload-1" })) as any;
    const projectId = a.session.projectId as string;
    const h1 = startConfig(t, { product: "ruukoto-dev" });
    try {
      await waitForText(h1.terminal, "配置分区");
      h1.terminal.send(DOWN + ENTER);
      await waitForText(h1.terminal, `工作区 · ${a.projectName}`);
      h1.terminal.send(ENTER);
      await waitForText(h1.terminal, "指令文件：");
      h1.terminal.send(DOWN + DOWN + DOWN + ENTER); // → 本项目 MCP
      await waitForText(h1.terminal, "新增服务");
      await waitFor("重载状态落盘", () => {
        try {
          const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          return s.kind === "config-tui" && JSON.stringify(s.section) === JSON.stringify(["projects", `project:${projectId}`, "mcp"]);
        } catch {
          return false;
        }
      });
    } finally {
      assert.equal(await h1.quit(), 0);
    }

    const h2 = startConfig(t, { product: "ruukoto-dev" });
    try {
      await waitForText(h2.terminal, `MCP 服务（${a.projectName}）`, "重载后直接恢复到该项目的 MCP 分区");
    } finally {
      assert.equal(await h2.quit(), 0);
    }
  } finally {
    if (origEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = origEnv;
    await rm(stateDir, { recursive: true, force: true });
    await t.shutdown();
  }
});

test("重载状态指向其他项目的服务：不打开归属不符的服务，停留在本项目 MCP 列表", async () => {
  const t = await startTestRuntime("cfg-tui-ws-xsvc", textResponder);
  const stateDir = await mkdtemp(path.join(tmpdir(), "ruukoto-cfg-ws-xsvc-"));
  const stateFile = path.join(stateDir, "reload.json");
  const envKey = "RUUKOTO_RELOAD_STATE_FILE";
  const origEnv = process.env[envKey];
  process.env[envKey] = stateFile;
  try {
    const a = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "ws-xsvc-a" })) as any;
    const b = (await t.client.request<any>("open_workspace", { cwd: t.work[1]!, request_id: "ws-xsvc-b" })) as any;
    const projectA = a.session.projectId as string;
    const projectB = b.session.projectId as string;
    await t.client.request("mcp_configure", { project_id: projectA, name: "docsa", endpoint: "https://a.example.com/mcp", tool_allowlist: [] });
    const svcB = (await t.client.request<any>("mcp_configure", { project_id: projectB, name: "otherb", endpoint: "https://b.example.com/mcp", tool_allowlist: [] })) as any;
    const { snapshot } = await t.client.handshake();
    fs.writeFileSync(stateFile, JSON.stringify({
      kind: "config-tui",
      instanceId: snapshot.instanceId,
      section: ["projects", `project:${projectA}`, "mcp", `svc:${svcB.id}`],
      updatedAt: "",
    }));
    const h = startConfig(t, { product: "ruukoto-dev" });
    try {
      await waitForText(h.terminal, "已不存在", "归属其他项目的服务不随重载打开");
      assert.ok(h.terminal.output().includes("docsa"), "停留在本项目 MCP 列表");
      assert.ok(!h.terminal.output().includes("otherb"), "归属其他项目的服务不出现在本项目列表");
    } finally {
      assert.equal(await h.quit(), 0);
    }
  } finally {
    if (origEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = origEnv;
    await rm(stateDir, { recursive: true, force: true });
    await t.shutdown();
  }
});

test("mcp_remove 期望版本：匹配删除成功；陈旧版本冲突且服务仍在；不带版本兼容删除", async () => {
  const t = await startTestRuntime("cfg-tui-mcp-remove", textResponder);
  try {
    const p = (await t.client.request<any>("create_project", { name: "proj-mcp-rm" })) as any;
    const svc = (await t.client.request<any>("mcp_configure", {
      project_id: p.id, name: "docs", endpoint: "https://docs.example.com/mcp", tool_allowlist: ["search"],
    })) as any;
    const svc2 = (await t.client.request<any>("mcp_configure", {
      project_id: p.id, name: "docs", endpoint: "https://docs.example.com/mcp", tool_allowlist: ["search", "fetch"], expected_version: svc.configVersion,
    })) as any;

    const conflict = await t.client.request("mcp_remove", { service_id: svc.id, expected_version: svc.configVersion }).then(
      () => null,
      (err: any) => err,
    );
    assert.equal(conflict?.code, "version_conflict", "陈旧版本 → version_conflict");
    const stillThere = (await t.client.request<any>("mcp_list", {})) as any;
    assert.ok((stillThere.services as any[]).some((s) => s.id === svc.id), "冲突后服务仍在");

    const removed = (await t.client.request<any>("mcp_remove", { service_id: svc.id, expected_version: svc2.configVersion })) as any;
    assert.equal(removed.removed, true, "版本匹配删除成功");

    const svc3 = (await t.client.request<any>("mcp_configure", {
      project_id: p.id, name: "docs", endpoint: "https://docs.example.com/mcp", tool_allowlist: [],
    })) as any;
    const removedNoVersion = (await t.client.request<any>("mcp_remove", { service_id: svc3.id })) as any;
    assert.equal(removedNoVersion.removed, true, "不带版本仍删成功（兼容）");
  } finally {
    await t.shutdown();
  }
});

test("ruukoto-dev：工作区详情列出关联旧资料与原配置入口；来源设置按来源版本访问（issue 07 步骤 4）", async () => {
  const t = await startTestRuntime("cfg-tui-ws-sources", textResponder);
  try {
    const ws = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "ws-src-1" })) as any;
    const wsId = ws.session.projectId as string;
    const legacy = (await t.client.request<any>("create_project", { name: "legacy-src" })) as any;
    const mapped = (await t.client.request<any>("create_session", { project_id: legacy.id, cwd: t.work[1]! })) as any;
    t.runtime.store.withTx(() => t.runtime.store.mapSessionToWorkspace(mapped.id, wsId));
    await t.client.request("mcp_configure", {
      project_id: legacy.id, name: "docs", endpoint: "https://docs.example.com/mcp", tool_allowlist: ["search"],
    });
    await t.client.request("create_data_grant", {
      from_project_id: legacy.id, to_project_id: wsId, category: "history", purpose: "旧历史供工作区查阅",
    });

    const h = startConfig(t, { product: "ruukoto-dev" });
    try {
      await waitForText(h.terminal, "配置分区");
      h.terminal.send(DOWN + ENTER); // 项目
      await waitForText(h.terminal, `工作区 · ${ws.projectName}`);
      h.terminal.send(ENTER); // 工作区（首项）
      await waitForText(h.terminal, "关联旧资料来源 1 项");
      await waitForText(h.terminal, "关联旧资料：legacy-src");
      const out = h.terminal.output();
      assert.ok(out.includes("1 个映射会话"), "列出对应会话");
      assert.ok(out.includes("MCP 1 项"), "列出 MCP 引用");
      assert.ok(out.includes("授权 出 1 / 入 0"), "列出原授权方向（不隐式合并）");
      assert.ok(out.includes("v1"), "来源设置版本并列显示");
      // 打开原配置入口：来源项目的指令/版本页面（沿用 06 的版本校验）
      const beforeEnter = h.terminal.output().length;
      h.terminal.send(DOWN + DOWN + DOWN + DOWN + DOWN + ENTER); // instructions..grants → 关联旧资料
      await waitForText(h.terminal, "项目 legacy-src");
      const tail = h.terminal.output().slice(beforeEnter);
      assert.ok(tail.includes("指令文件："), "来源详情打开");
      assert.ok(tail.includes("旧项目"), "来源项目自身标注（不是工作区）");
      assert.ok(!tail.includes("关联旧资料"), "来源详情不反向合并工作区");
      h.terminal.send(ESC); // 回工作区详情
      await waitForText(h.terminal, "关联旧资料：legacy-src");
    } finally {
      assert.equal(await h.quit(), 0);
    }
  } finally {
    await t.shutdown();
  }
});
