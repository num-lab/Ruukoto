/**
 * 双产品独立入口与隔离测试（agent-direction issue 01，ADR 0017）。
 *
 * 测试接缝（预先约定）：
 * - src/core/product.ts：productFromEnv / productRootDir / dirEnvFor 纯函数（产品身份与
 *   档案根、路径环境变量隔离）；
 * - src/control/connect.ts 与 pending-requests.ts：默认目录解析按产品取本产品的环境
 *   变量与档案根，不读对方产品的路径变量；
 * - src/dev.ts buildChildEnv：开发实例洗落继承的产品身份与双方产品目录变量，
 *   按开发入口钉定身份与自身档案（不误用日常产品与开发实例）；
 * - Runtime.start 的产品 gating 可观察行为：ruukoto-code 停用 QQ/Telegram 连接与轮询、个人
 *   调度不可用、数据目录跨产品复用被拒绝（meta 登记，兼容扩展）；
 * - 进程冒烟：bin/ruukoto-code.mjs 入口与非法 RUUKOTO_PRODUCT 的快速失败（不需要后台）。
 * - 进程级：两条 bin 入口固定产品身份——继承相反 RUUKOTO_PRODUCT 时查询与停止只作用于
 *   本产品（评审 R6，真实 bin 后台进程）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PRODUCT_TYPES, dirEnvFor, productFromEnv, productRootDir } from "../src/core/product.ts";

// ---- 单元：产品身份 ----

test("productFromEnv：未设置/空串默认 ruukoto，ruukoto-code 显式可选", () => {
  assert.equal(productFromEnv({}), "ruukoto");
  assert.equal(productFromEnv({ RUUKOTO_PRODUCT: "" }), "ruukoto");
  assert.equal(productFromEnv({ RUUKOTO_PRODUCT: "ruukoto" }), "ruukoto");
  assert.equal(productFromEnv({ RUUKOTO_PRODUCT: "ruukoto-code" }), "ruukoto-code");
});

test("productFromEnv：非法取值直接报错（不静默落到错误产品）", () => {
  assert.throws(() => productFromEnv({ RUUKOTO_PRODUCT: "bogus" }), /RUUKOTO_PRODUCT/);
});

test("产品枚举恰好两个且不重叠", () => {
  assert.deepStrictEqual([...PRODUCT_TYPES].sort(), ["ruukoto", "ruukoto-code"]);
});

test("productRootDir：两产品独立根，均不等于开发实例根 ~/.ruukoto-dev", () => {
  const home = "/home/tester";
  const a = productRootDir("ruukoto", home);
  const b = productRootDir("ruukoto-code", home);
  assert.notEqual(a, b);
  assert.equal(a, "/home/tester/.ruukoto");
  assert.notEqual(b, "/home/tester/.ruukoto-dev");
  assert.ok(!b.startsWith("/home/tester/.ruukoto-dev" + (process.platform === "win32" ? "\\" : "/")));
});

// ---- 单元：路径环境变量按产品隔离 ----

test("dirEnvFor：ruukoto 读 RUUKOTO_*_DIR，ruukoto-code 只读 RUUKOTO_CODE_*_DIR", () => {
  const env: NodeJS.ProcessEnv = {
    RUUKOTO_DATA_DIR: "/shared/data",
    RUUKOTO_CODE_DATA_DIR: "/dev/data",
  };
  assert.equal(dirEnvFor("ruukoto", "DATA", env), "/shared/data");
  assert.equal(dirEnvFor("ruukoto-code", "DATA", env), "/dev/data");
  // 未设置对应产品的变量时回落到空，不读对方产品的变量
  assert.equal(dirEnvFor("ruukoto-code", "AGENT", env), undefined);
  assert.equal(dirEnvFor("ruukoto", "AGENT", env), undefined);
});

// ---- 默认目录解析按产品隔离 ----

import { controlDirFor, defaultAgentDir, defaultDataDir } from "../src/control/connect.ts";
import { defaultPendingDir } from "../src/control/pending-requests.ts";
import * as nodePath from "node:path";

const DIR_ENV_VARS = [
  "RUUKOTO_PRODUCT",
  "RUUKOTO_DATA_DIR",
  "RUUKOTO_AGENT_DIR",
  "RUUKOTO_CONTROL_DIR",
  "RUUKOTO_PENDING_DIR",
  "RUUKOTO_CODE_DATA_DIR",
  "RUUKOTO_CODE_AGENT_DIR",
  "RUUKOTO_CODE_CONTROL_DIR",
  "RUUKOTO_CODE_PENDING_DIR",
] as const;

/** 覆盖/清空一组环境变量执行 fn，结束后还原（测试运行器自身环境可能带 RUUKOTO_*）。 */
function withCleanEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  for (const key of DIR_ENV_VARS) if (!(key in overrides)) overrides[key] = undefined;
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("ruukoto（默认产品）：沿用 ~/.ruukoto 布局与 RUUKOTO_*_DIR 覆盖", () => {
  withCleanEnv({}, () => {
    assert.ok(defaultDataDir().endsWith(nodePath.join(".ruukoto", "data")));
    assert.ok(defaultAgentDir().endsWith(nodePath.join(".ruukoto", "agent")));
    assert.ok(controlDirFor(defaultDataDir()).endsWith(nodePath.join(".ruukoto", "control")));
    assert.ok(defaultPendingDir().endsWith(nodePath.join(".ruukoto", "pending")));
  });
  withCleanEnv({ RUUKOTO_DATA_DIR: "/x/data", RUUKOTO_PENDING_DIR: "/x/pending" }, () => {
    assert.equal(defaultDataDir(), "/x/data");
    assert.equal(controlDirFor("/x/data"), "/x/control");
    assert.equal(defaultPendingDir(), "/x/pending");
  });
});

test("ruukoto-code：独立档案根与 RUUKOTO_CODE_*_DIR 覆盖，不读对方产品的路径变量", () => {
  const product = { RUUKOTO_PRODUCT: "ruukoto-code" };
  withCleanEnv(product, () => {
    assert.ok(defaultDataDir().endsWith(nodePath.join(".ruukoto-code", "data")));
    assert.ok(defaultAgentDir().endsWith(nodePath.join(".ruukoto-code", "agent")));
    assert.ok(controlDirFor(defaultDataDir()).endsWith(nodePath.join(".ruukoto-code", "control")));
    assert.ok(defaultPendingDir().endsWith(nodePath.join(".ruukoto-code", "pending")));
  });
  withCleanEnv(
    {
      ...product,
      RUUKOTO_DATA_DIR: "/shared/data",
      RUUKOTO_CODE_DATA_DIR: "/dev/data",
      RUUKOTO_CONTROL_DIR: "/shared/control",
      RUUKOTO_CODE_CONTROL_DIR: "/dev/control",
      RUUKOTO_PENDING_DIR: "/shared/pending",
      RUUKOTO_CODE_PENDING_DIR: "/dev/pending",
    },
    () => {
      assert.equal(defaultDataDir(), "/dev/data");
      assert.equal(controlDirFor(defaultDataDir()), "/dev/control");
      assert.equal(controlDirFor("/explicit/data"), "/dev/control");
      assert.equal(defaultPendingDir(), "/dev/pending");
    },
  );
});

// ---- 开发实例不继承日常产品身份与目录 ----

import { buildChildEnv, devProfileFor } from "../src/dev.ts";

test("buildChildEnv：双开发入口覆盖继承身份，清洗双方日常目录并钉定各自档案", () => {
  for (const product of PRODUCT_TYPES) {
    const profile = devProfileFor("/some/repo", "/home/tester", product);
    const env = buildChildEnv(
      {
        RUUKOTO_PRODUCT: product === "ruukoto" ? "ruukoto-code" : "ruukoto",
        RUUKOTO_CODE_DATA_DIR: "/daily-code/data",
        RUUKOTO_CODE_AGENT_DIR: "/daily-code/agent",
        RUUKOTO_CODE_CONTROL_DIR: "/daily-code/control",
        RUUKOTO_CODE_PENDING_DIR: "/daily-code/pending",
        RUUKOTO_DATA_DIR: "/daily-personal/data",
        RUUKOTO_AGENT_DIR: "/daily-personal/agent",
        RUUKOTO_CONTROL_DIR: "/daily-personal/control",
        RUUKOTO_PENDING_DIR: "/daily-personal/pending",
        RUUKOTO_OWNER_TOKEN: "daily-token",
        RUUKOTO_OWNER_TOKEN_FILE: "/daily-owner.token",
        RUUKOTO_EXECUTION_BACKEND: "local",
        RUUKOTO_EXEC_UID: "900",
        RUUKOTO_CONTAINER_IMAGE: "daily-image",
        RUUKOTO_WORKER_IMAGE: "daily-worker",
        PATH: "/usr/bin",
      },
      profile,
    );
    const prefix = product === "ruukoto" ? "RUUKOTO" : "RUUKOTO_CODE";
    const otherPrefix = product === "ruukoto" ? "RUUKOTO_CODE" : "RUUKOTO";
    assert.equal(env.RUUKOTO_PRODUCT, product);
    for (const [kind, dir] of Object.entries({ DATA: profile.dataDir, AGENT: profile.agentDir, CONTROL: profile.controlDir, PENDING: profile.pendingDir })) {
      assert.equal(env[`${prefix}_${kind}_DIR`], dir);
      assert.equal(env[`${otherPrefix}_${kind}_DIR`], undefined, "不保留另一个产品的日常目录");
    }
    for (const key of ["RUUKOTO_OWNER_TOKEN", "RUUKOTO_OWNER_TOKEN_FILE", "RUUKOTO_EXECUTION_BACKEND", "RUUKOTO_EXEC_UID", "RUUKOTO_CONTAINER_IMAGE", "RUUKOTO_WORKER_IMAGE"]) {
      assert.equal(env[key], undefined, `${product} 不继承 ${key}`);
    }
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.RUUKOTO_DISABLE_QQ, "1");
    assert.equal(env.RUUKOTO_DISABLE_TELEGRAM, "1");
  }
});

// ---- Runtime 产品 gating（集成，MockModelServer，模拟模型、真实存储与锁） ----

import { Runtime } from "../src/runtime/runtime.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { cleanupDirs, makeTestDirs, startTestRuntime, writeModelsJson } from "./helpers/testkit.ts";

test("ruukoto-code：停用 QQ/Telegram 连接与轮询、个人调度不可用、旧记录仍可读", async () => {
  const t = await startTestRuntime("product-dev", async () => ({ kind: "text", text: "ok" }), {
    config: { productType: "ruukoto-code" },
  });
  try {
    // 消息平台连接与轮询停用：状态明确标注为产品 gating，而不是"未启动/连接异常"
    const qq = t.runtime.qqStatus() as { disabledByConfig?: boolean; stateDetail?: string };
    assert.equal(qq.disabledByConfig, true);
    assert.match(qq.stateDetail ?? "", /ruukoto-code/);
    const telegram = t.runtime.telegramStatus() as { disabledByConfig?: boolean; stateDetail?: string };
    assert.equal(telegram.disabledByConfig, true);
    assert.match(telegram.stateDetail ?? "", /ruukoto-code/);
    // 个人调度：调度器不启动；取消操作明确拒绝而不是静默丢弃
    assert.equal(t.runtime.scheduler, null);
    await assert.rejects(
      t.runtime.scheduleCancel({ scheduleId: "sch_x", expectedVersion: 1, reason: "清理" }),
      /个人调度|未启用/,
    );
    // 兼容扩展：既有计划记录在本产品库内照常可读（不重命名、不改旧行）
    const seeded = t.runtime.sched.insertSchedule(
      {
        createKey: "test-seed",
        paramsDigest: "d",
        createTaskId: null,
        createOpId: null,
        action: "notify",
        rule: { kind: "once", at: "2099-01-01T00:00:00.000Z", timeZone: "Asia/Shanghai", disambiguation: "compatible" },
        payload: { text: "旧计划正文", sourceRefs: [] },
        target: null,
        approvalId: null,
        nextDueAt: null,
        tzData: "Asia/Shanghai",
        reason: "测试种子",
      },
      "test",
    );
    const list = t.runtime.scheduleList({});
    assert.equal(list.schedules.length, 1);
    assert.equal(list.schedules[0]!.id, seeded.id);
    assert.equal(t.runtime.scheduleGet(seeded.id).schedule.payload.text, "旧计划正文");
  } finally {
    await t.shutdown();
  }
});

test("ruukoto（默认产品）：调度器照常启动", async () => {
  const t = await startTestRuntime("product-default", async () => ({ kind: "text", text: "ok" }));
  try {
    assert.notEqual(t.runtime.scheduler, null);
  } finally {
    await t.shutdown();
  }
});

test("数据目录归属：跨产品复用被拒绝，同产品重启正常（meta 兼容扩展）", async () => {
  const { dirs } = await makeTestDirs("product-owner");
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const startRuntime = (productType: "ruukoto" | "ruukoto-code") =>
    Runtime.start({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      socketPath: nodePath.join(dirs.root, "c.sock"),
      thinkingLevel: "off",
      productType,
    });
  try {
    const first = await startRuntime("ruukoto-code");
    await first.stop("test_end");
    // 同一数据目录换产品启动：拒绝（配置与数据不串用）
    await assert.rejects(startRuntime("ruukoto"), /product_mismatch|归属产品/);
    // 同产品重启：正常（登记不重复要求）
    const second = await startRuntime("ruukoto-code");
    await second.stop("test_end");
  } finally {
    await server.close();
    await cleanupDirs(dirs);
  }
});

// ---- 进程冒烟（不需要后台，仿 29-cli-entry 的模式） ----

import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

function runNode(argv: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string } {
  const r = childProcess.spawnSync(process.execPath, argv, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  if (r.error) throw r.error;
  return { status: r.status, stderr: r.stderr };
}

test("进程：bin/ruukoto-code.mjs 入口引导 TS，未知名字按工作区处理（非 TTY 退出 1）", () => {
  const r = runNode([nodePath.join(repoRoot, "bin", "ruukoto-code.mjs"), "bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TTY/);
});

test("进程：非法 RUUKOTO_PRODUCT 快速失败并说明取值", () => {
  const r = runNode(
    [nodePath.join(repoRoot, "node_modules", ".bin", "tsx"), "src/cli.ts", "server"],
    { RUUKOTO_PRODUCT: "bogus" },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RUUKOTO_PRODUCT/);
});

// ---- 进程级同机并存（真实 bin 后台进程；模型打桩：模拟模型，真实进程/文件/socket/SQLite） ----

import { authenticateClient } from "./helpers/testkit.ts";
import { ControlClient } from "../src/control/client.ts";
import { killProcessTree } from "./helpers/backend.ts";

interface SpawnedBackend {
  child: childProcess.ChildProcess;
  controlDir: string;
  exit(): Promise<number | null>;
}

/** spawn 真实 bin 后台（detached 便于整组回收）；注入干净环境，只给本产品的控制面变量。 */
async function spawnProductBackend(
  product: "ruukoto" | "ruukoto-code",
  dirs: { dataDir: string; agentDir: string; root: string },
): Promise<SpawnedBackend> {
  const controlDir = nodePath.join(dirs.root, "control");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  env[product === "ruukoto" ? "RUUKOTO_CONTROL_DIR" : "RUUKOTO_CODE_CONTROL_DIR"] = controlDir;
  const binFile = product === "ruukoto" ? "ruukoto.mjs" : "ruukoto-code.mjs";
  const child = childProcess.spawn(
    process.execPath,
    [nodePath.join(repoRoot, "bin", binFile), "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--tools", "mock"],
    { cwd: repoRoot, env, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const socketPath = nodePath.join(controlDir, "control.sock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${product} 后台提前退出：${stderr.slice(0, 2000)}`);
    }
    try {
      const client = await ControlClient.connect(socketPath, 1500);
      await authenticateClient(client, controlDir);
      await client.handshake();
      client.close();
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        killProcessTree(child);
        throw new Error(`${product} 后台连接超时：${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return {
    child,
    controlDir,
    exit: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        const timer = setTimeout(() => resolve(-1), 20_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      }),
  };
}

async function connectAuthed(controlDir: string): Promise<ControlClient> {
  const client = await ControlClient.connect(nodePath.join(controlDir, "control.sock"), 3000);
  await authenticateClient(client, controlDir);
  await client.handshake();
  return client;
}

test("进程级：两产品同机并存、独立停止；跨产品打开目录被拒绝", async () => {
  const { dirs: prodDirs } = await makeTestDirs("coexist-personal", 0);
  const { dirs: devDirs } = await makeTestDirs("coexist-coding", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeModelsJson(prodDirs, baseUrl);
  await writeModelsJson(devDirs, baseUrl);
  let prod: SpawnedBackend | null = null;
  let dev: SpawnedBackend | null = null;
  try {
    prod = await spawnProductBackend("ruukoto", { dataDir: prodDirs.dataDir, agentDir: prodDirs.agentDir, root: prodDirs.root });
    dev = await spawnProductBackend("ruukoto-code", { dataDir: devDirs.dataDir, agentDir: devDirs.agentDir, root: devDirs.root });

    const devClient = await connectAuthed(dev.controlDir);
    const qq = (await devClient.request<any>("qq_status")) as { disabledByConfig?: boolean; stateDetail?: string };
    assert.equal(qq.disabledByConfig, true);
    assert.match(qq.stateDetail ?? "", /ruukoto-code/);
    // 独立停止：停 ruukoto-code 不影响 ruukoto
    await devClient.request("stop");
    devClient.close();
    assert.equal(await dev.exit(), 0);
    const prodClient = await connectAuthed(prod.controlDir);
    const prodQq = (await prodClient.request<any>("qq_status")) as { disabledByConfig?: boolean };
    assert.notEqual(prodQq.disabledByConfig, true);
    await prodClient.request("stop");
    prodClient.close();
    assert.equal(await prod.exit(), 0);
    dev = null;
    prod = null;

    // 后台已停（锁释放）：以 ruukoto-code 打开已归属 ruukoto 的数据目录 → 拒绝
    const misuse = childProcess.spawn(
      process.execPath,
      [
        nodePath.join(repoRoot, "node_modules", ".bin", "tsx"),
        "src/cli.ts",
        "server",
        "--data-dir",
        prodDirs.dataDir,
        "--agent-dir",
        prodDirs.agentDir,
      ],
      { cwd: repoRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_PRODUCT: "ruukoto-code" }, stdio: ["ignore", "ignore", "pipe"] },
    );
    let errText = "";
    misuse.stderr!.on("data", (c: Buffer) => (errText += c.toString("utf8")));
    const misuseCode = await new Promise<number | null>((r) => misuse.once("exit", (c) => r(c)));
    assert.notEqual(misuseCode, 0);
    assert.match(errText, /product_mismatch|归属产品/);
  } finally {
    if (prod) killProcessTree(prod.child);
    if (dev) killProcessTree(dev.child);
    await server.close();
    await cleanupDirs(prodDirs);
    await cleanupDirs(devDirs);
  }
});

test("进程级：bin 入口固定产品身份——继承相反 RUUKOTO_PRODUCT 时启动/查询/停止只作用于本产品（评审 R6）", async () => {
  const { dirs: prodDirs } = await makeTestDirs("pin-personal", 0);
  const { dirs: devDirs } = await makeTestDirs("pin-coding", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeModelsJson(prodDirs, baseUrl);
  await writeModelsJson(devDirs, baseUrl);
  let prod: SpawnedBackend | null = null;
  let dev: SpawnedBackend | null = null;
  try {
    // 两个真实 bin 后台各自启动于本产品（启动入口本身即固定身份路径）
    prod = await spawnProductBackend("ruukoto", { dataDir: prodDirs.dataDir, agentDir: prodDirs.agentDir, root: prodDirs.root });
    dev = await spawnProductBackend("ruukoto-code", { dataDir: devDirs.dataDir, agentDir: devDirs.agentDir, root: devDirs.root });

    // shell 继承相反产品变量（两个产品的控制面变量同时可见）：ruukoto bin 不得采信
    const env = {
      RUUKOTO_PRODUCT: "ruukoto-code",
      RUUKOTO_CONTROL_DIR: prod.controlDir,
      RUUKOTO_CODE_CONTROL_DIR: dev.controlDir,
    };
    const prodStatus = runNode([nodePath.join(repoRoot, "bin", "ruukoto.mjs"), "status"], env);
    assert.equal(prodStatus.status, 0, `个人 bin 查询应指向个人后台：${prodStatus.stderr}`);
    assert.equal(runNode([nodePath.join(repoRoot, "bin", "ruukoto.mjs"), "stop"], env).status, 0);
    assert.equal(await prod.exit(), 0, "个人后台被自己的 bin 停止");
    prod = null;
    const devClient = await connectAuthed(dev.controlDir); // 开发后台不受影响：仍可握手
    devClient.close();

    // 对称：ruukoto-code bin 在 RUUKOTO_PRODUCT=ruukoto 下只作用于开发产品
    const devStatus = runNode([nodePath.join(repoRoot, "bin", "ruukoto-code.mjs"), "status"], { ...env, RUUKOTO_PRODUCT: "ruukoto" });
    assert.equal(devStatus.status, 0, `开发 bin 查询应指向开发后台：${devStatus.stderr}`);
    assert.equal(runNode([nodePath.join(repoRoot, "bin", "ruukoto-code.mjs"), "stop"], { ...env, RUUKOTO_PRODUCT: "ruukoto" }).status, 0);
    assert.equal(await dev.exit(), 0, "开发后台被自己的 bin 停止");
    dev = null;
  } finally {
    if (prod) killProcessTree(prod.child);
    if (dev) killProcessTree(dev.child);
    await server.close();
    await cleanupDirs(prodDirs);
    await cleanupDirs(devDirs);
  }
});
