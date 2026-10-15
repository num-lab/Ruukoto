import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";

const eslint = new ESLint();
const root = path.resolve(import.meta.dirname, "..");

test("workspace 安装的两条 bin 链接指向各自 app 的可执行入口", () => {
  for (const product of ["ruukoto", "ruukoto-code"]) {
    const linked = fs.realpathSync(path.join(root, "node_modules", ".bin", product));
    const entry = path.join(root, "apps", product, "bin", `${product}.mjs`);
    assert.equal(linked, fs.realpathSync(entry));
    fs.accessSync(linked, fs.constants.X_OK);
  }
});

test("每个 app 的 npm start 与 dev 脚本均能进入自己的入口", () => {
  for (const product of ["ruukoto", "ruukoto-code"]) {
    const start = spawnSync("npm", ["start", `--workspace=${product}`, "--", "--nope"], { cwd: root, encoding: "utf8" });
    assert.equal(start.status, 1, start.stderr);
    assert.match(start.stderr, /参数错误/);
    assert.match(start.stderr, /用法/);
    const invalid = spawnSync("npm", ["run", "dev", `--workspace=${product}`, "--", "--nope"], { cwd: root, encoding: "utf8" });
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /参数错误/);
  }
});

async function violations(file: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath: path.join(root, file) });
  return result.messages.filter((message) => message.ruleId === "workspaces/imports");
}

test("包边界：core 的类型反向引用、agent 的值反向引用与相对绕过均拒绝", async () => {
  for (const [file, source] of [
    ["packages/core/src/probe.ts", 'import type { Runtime } from "@ruukoto/runtime/runtime.ts";'],
    ["packages/agent/src/probe.ts", 'import { Runtime } from "@ruukoto/runtime/runtime.ts";'],
    ["packages/agent/src/probe.ts", 'export { Runtime } from "@ruukoto/runtime/runtime.ts";'],
    ["packages/agent/src/probe.ts", 'await import("@ruukoto/runtime/runtime.ts");'],
    ["packages/agent/src/probe.ts", 'import type { Runtime } from "../../runtime/src/runtime.ts";'],
    ["packages/agent/src/probe.ts", 'await import("ruukoto/product.ts");'],
    ["packages/core/src/probe.ts", 'type Runtime = import("@ruukoto/runtime/runtime.ts").Runtime;'],
    ["packages/agent/src/probe.ts", 'const moduleName = "@ruukoto/runtime/runtime.ts"; await import(moduleName);'],
    ["apps/ruukoto-code/src/probe.ts", 'import { product } from "ruukoto/product.ts";'],
  ]) assert.ok((await violations(file, source)).length > 0, source);
});

test("包边界：声明过的底层依赖、反向类型与包内引用可用", async () => {
  for (const [file, source] of [
    ["packages/agent/src/probe.ts", 'import { Store } from "@ruukoto/core/store.ts";'],
    ["packages/agent/src/probe.ts", 'import type { Runtime } from "@ruukoto/runtime/runtime.ts";'],
    ["packages/agent/src/probe.ts", 'import { type Runtime } from "@ruukoto/runtime/runtime.ts";'],
    ["packages/agent/src/probe.ts", 'type Runtime = import("@ruukoto/runtime/runtime.ts").Runtime;'],
    ["packages/agent/src/probe.ts", 'import { Driver } from "./driver.ts";'],
    ["apps/ruukoto-code/src/probe.ts", 'await import("@ruukoto/tui/cli.ts");'],
  ]) assert.deepEqual(await violations(file, source), [], source);
});

test("包边界：桌面包可用 devDependency 的值引用，其他约束照常生效", async () => {
  for (const source of [
    'import { app } from "electron";',
    'export { ControlConnection } from "@ruukoto/control/connection.ts";',
    'await import("@ruukoto/core/paths.ts");',
  ]) assert.deepEqual(await violations("apps/desktop/src/probe.ts", source), [], source);
  for (const [file, source] of [
    ["apps/desktop/src/probe.ts", 'import { missing } from "undeclared-desktop-dependency";'],
    ["apps/desktop/src/probe.ts", 'import { Store } from "../../../packages/core/src/store.ts";'],
    ["apps/desktop/src/probe.ts", 'const moduleName = "electron"; await import(moduleName);'],
    ["packages/control/src/probe.ts", 'import { Runtime } from "@ruukoto/runtime/runtime.ts";'],
  ]) assert.ok((await violations(file, source)).length > 0, source);
  const control = await violations("packages/control/src/probe.ts", 'import { Runtime } from "@ruukoto/runtime/runtime.ts";');
  assert.ok(control.some(message => message.messageId === "undeclared"), "桌面例外不能放开其他包的 devDependency 值引用");
});
