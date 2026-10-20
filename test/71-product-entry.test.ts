import { product as personalProduct } from "./helpers/legacy-product.ts";
import { product as codingProduct } from "../apps/ruukoto-code/src/product.ts";
/** Coding 产品入口、旧格式隔离与共享开发启动器；新个人进程验收见 personal-entry.test.ts。 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PRODUCT_TYPES, dirEnvFor, productFromEnv, productRootDir } from "@ruukoto/core/product.ts";

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

import { controlDirFor, defaultAgentDir, defaultDataDir, socketPathFor } from "@ruukoto/control/connect.ts";
import { defaultPendingDir } from "@ruukoto/control/pending-requests.ts";
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

test("显式产品：全局产品固定时可交替解析两个产品的目录与 socket", () => {
  withCleanEnv({ RUUKOTO_PRODUCT: "ruukoto-code" }, () => {
    for (const product of ["ruukoto", "ruukoto-code", "ruukoto"] as const) {
      const root = productRootDir(product);
      const dataDir = defaultDataDir(product);
      const controlDir = controlDirFor(dataDir, product);
      assert.equal(dataDir, nodePath.join(root, "data"));
      assert.equal(defaultAgentDir(product), nodePath.join(root, "agent"));
      assert.equal(controlDir, nodePath.join(root, "control"));
      assert.equal(socketPathFor(controlDir), nodePath.join(root, "control", "control.sock"));
      assert.equal(controlDirFor(nodePath.join(root, "custom", "data"), product), nodePath.join(root, "custom", "control"));
    }
    assert.equal(process.env.RUUKOTO_PRODUCT, "ruukoto-code");
    assert.equal(defaultDataDir(), defaultDataDir("ruukoto-code"));
    assert.equal(defaultAgentDir(), defaultAgentDir("ruukoto-code"));
    assert.equal(controlDirFor(defaultDataDir()), controlDirFor(defaultDataDir(), "ruukoto-code"));
  });
});

test("显式产品：双方 DATA、AGENT、CONTROL 环境覆盖并存时互不串用", () => {
  withCleanEnv({
    RUUKOTO_PRODUCT: "ruukoto",
    RUUKOTO_DATA_DIR: "/personal/data",
    RUUKOTO_AGENT_DIR: "/personal/agent",
    RUUKOTO_CONTROL_DIR: "/personal/control",
    RUUKOTO_CODE_DATA_DIR: "/code/data",
    RUUKOTO_CODE_AGENT_DIR: "/code/agent",
    RUUKOTO_CODE_CONTROL_DIR: "/code/control",
  }, () => {
    for (const product of ["ruukoto-code", "ruukoto", "ruukoto-code"] as const) {
      const root = product === "ruukoto" ? "/personal" : "/code";
      assert.equal(defaultDataDir(product), `${root}/data`);
      assert.equal(defaultAgentDir(product), `${root}/agent`);
      assert.equal(controlDirFor("/explicit/data", product), `${root}/control`);
      assert.equal(socketPathFor(controlDirFor(defaultDataDir(product), product)), `${root}/control/control.sock`);
    }
    assert.equal(defaultDataDir(), "/personal/data");
    assert.equal(defaultAgentDir(), "/personal/agent");
    assert.equal(controlDirFor(defaultDataDir()), "/personal/control");
  });
});

// ---- 开发实例不继承日常产品身份与目录 ----

import { buildChildEnv, devProfileFor } from "@ruukoto/tui/dev.ts";

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
        RUUKOTO_SERVICE_SUDO: "900",
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
    for (const key of ["RUUKOTO_OWNER_TOKEN", "RUUKOTO_OWNER_TOKEN_FILE", "RUUKOTO_EXECUTION_BACKEND", "RUUKOTO_SERVICE_SUDO"]) {
      assert.equal(env[key], undefined, `${product} 不继承 ${key}`);
    }
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.RUUKOTO_DISABLE_QQ, "1");
    assert.equal(env.RUUKOTO_DISABLE_TELEGRAM, "1");
  }
});

// ---- Runtime 产品 gating（集成，MockModelServer，模拟模型、真实存储与锁） ----

import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { cleanupDirs, makeTestDirs, startTestRuntime, writeModelsJson } from "./helpers/testkit.ts";

test("ruukoto-code：停用 QQ/Telegram 连接与轮询、个人调度不可用、旧记录仍可读", async () => {
  const t = await startTestRuntime("product-dev", async () => ({ kind: "text", text: "ok" }), {
    config: { product: codingProduct.runtime },
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
        projectId: t.runtime.store.getAgentRole("main")!.projectId,
        createPermissionVersion: 1,
        accessMode: "confirm",
        rule: { kind: "once", at: "2099-01-01T00:00:00.000Z", timeZone: "Asia/Shanghai", disambiguation: "compatible" },
        instruction: "通用计划说明",
        sourceRefs: [],
        target: null,
        nextDueAt: null,
        tzData: "Asia/Shanghai",
        reason: "测试种子",
      },
      "test",
    );
    const list = t.runtime.scheduleList({});
    assert.equal(list.schedules.length, 1);
    assert.equal(list.schedules[0]!.id, seeded.id);
    assert.equal(t.runtime.scheduleGet(seeded.id).schedule.instruction, "通用计划说明");
  } finally {
    await t.shutdown();
  }
});

test("旧格式测试装配：调度器照常启动", async () => {
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
      product: productType === "ruukoto-code" ? codingProduct.runtime : personalProduct.runtime,
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

test("进程：apps/ruukoto-code/bin/ruukoto-code.mjs 入口引导 TS，未知名字按工作区处理（非 TTY 退出 1）", () => {
  const r = runNode([nodePath.join(repoRoot, "apps", "ruukoto-code", "bin", "ruukoto-code.mjs"), "bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TTY/);
});

test("进程：非法 RUUKOTO_PRODUCT 快速失败并说明取值", () => {
  const r = runNode(
    [nodePath.join(repoRoot, "node_modules", ".bin", "tsx"), "scripts/start.ts", "server"],
    { RUUKOTO_PRODUCT: "bogus" },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RUUKOTO_PRODUCT/);
});
