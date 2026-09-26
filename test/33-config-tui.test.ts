/**
 * 配置中心 TUI 集成（issue 21 §3）：假 Terminal + 真实后台/控制协议。
 *
 * 覆盖：
 * 1. 在线：导航到「模型与提供方」设置后台默认模型，经控制面核实落库；
 * 2. 在线：API key 经遮蔽输入写入 auth.json（0600、秘密不进终端输出）；
 * 3. 在线：修订冲突时提示「已重新加载」并刷新出新数据；
 * 4. 离线：后台持有配置锁时拒绝进入；独立目录可写 key/默认模型且退出后释放锁；
 * 5. 重载状态：导航分区持久化、重启恢复、损坏文件提示后回主菜单。
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
import {
  startTestRuntime,
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

async function waitForText(term: FakeTerminal, text: string, desc = text): Promise<void> {
  await waitFor(`屏幕出现「${desc}」`, () => term.output().includes(text));
}

function startConfig(t: TestRuntime, opts: { offline?: boolean } = {}): ConfigHarness {
  const terminal = new FakeTerminal();
  const done = runConfigTui({
    offline: opts.offline,
    terminal,
    connect: { socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! },
    agentDir: t.dirs.agentDir,
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
