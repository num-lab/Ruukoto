import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { build } from "vite";
import { checkBuild, DesktopBuildError } from "../apps/desktop/scripts/check-build.mjs";
import { PRODUCTION_CSP, productionCspPlugin } from "../apps/desktop/build/security.mjs";
import { vendorTerminal } from "../apps/desktop/build/terminal.mjs";

const encodedCsp = PRODUCTION_CSP.replaceAll("'", "&#39;");
const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${encodedCsp}">`;
const buildScript = path.resolve(import.meta.dirname, "../apps/desktop/scripts/check-build.mjs");

test("实际桌面构建保留终端 vendor 引用，原生模块不能被内联到 main 入口", () => {
  const desktop = path.resolve(import.meta.dirname, "../apps/desktop");
  const cli = path.resolve(import.meta.dirname, "../node_modules/electron-vite/bin/electron-vite.js");
  const result = spawnSync(process.execPath, [cli, "build"], { cwd: desktop, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const source = fs.readFileSync(path.join(desktop, "out/main/index.js"), "utf8");
  assert.match(source, /from ["']\.\/vendor\/node-pty\/lib\/index\.js["']/);
  assert.doesNotMatch(source, /function loadNativeModule\(/);
  assert.doesNotThrow(() => checkBuild(path.join(desktop, "out")));
});

test("桌面生产 CSP 仅给内置浏览器开放 HTTP(S)，预览图片允许 data；内联样式放行 xterm 运行时主题注入，脚本仍不开放", () => {
  assert.match(PRODUCTION_CSP, /(?:^|;)\s*default-src 'self'(?:;|$)/);
  assert.match(PRODUCTION_CSP, /(?:^|;)\s*style-src 'self' 'unsafe-inline'(?:;|$)/);
  assert.match(PRODUCTION_CSP, /(?:^|;)\s*frame-src http: https:(?:;|$)/);
  assert.match(PRODUCTION_CSP, /(?:^|;)\s*img-src 'self' data:(?:;|$)/);
  assert.ok(!PRODUCTION_CSP.includes("unsafe-eval"));
  assert.ok(!PRODUCTION_CSP.includes("script-src"));
  assert.ok(!PRODUCTION_CSP.includes("file:"));
});

test("加载页的独立位移重置在生产 CSS 压缩后保留，避免被 Dialog 默认位移拉到左上角", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-loading-css-"));
  try {
    fs.writeFileSync(path.join(root, "index.html"), '<html><head><link rel="stylesheet" href="/loading.css"></head><body></body></html>');
    fs.writeFileSync(path.join(root, "loading.css"), fs.readFileSync(new URL("../.scratch/desktop-shadcn/approved-demo-v4-connection-loading.css", import.meta.url)));
    await build({ root, configFile: false, logLevel: "silent", build: { target: "safari16", cssMinify: "lightningcss", outDir: path.join(root, "dist") } });
    const assets = path.join(root, "dist/assets"), file = fs.readdirSync(assets).find(name => name.endsWith(".css"));
    assert.ok(file, "必须生成生产 CSS");
    const css = fs.readFileSync(path.join(assets, file), "utf8");
    const rule = css.match(/\.connection-loading\[data-slot=(?:"dialog-content"|dialog-content)\]\{([^}]+)\}/)?.[1];
    assert.ok(rule, "必须保留加载页规则");
    assert.match(rule, /(?:^|;)translate:(?:none|initial)(?:;|$)/, "独立 translate 重置不可合并进 transform，否则 Tailwind 的 -50% 位移仍生效");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-desktop-build-"));
  for (const directory of ["renderer", "main", "preload"]) fs.mkdirSync(path.join(root, directory));
  vendorTerminal(path.join(root, "main"));
  fs.writeFileSync(path.join(root, "renderer/index.html"), `<!doctype html><html><head>${cspMeta}<meta charset="utf-8"></head><body></body></html>`);
  fs.writeFileSync(path.join(root, "main/index.js"), 'import { app } from "electron"; import fs from "node:fs"; await import("node:sqlite");');
  fs.writeFileSync(path.join(root, "preload/index.cjs"), 'const { contextBridge } = require("electron"); const path = require("path");');
  return root;
}

test("桌面 CSP 插件：仅在构建时将生产策略放到 head 首位", async () => {
  const root = fixture();
  try {
    const source = '<!doctype html><html><head><meta charset="utf-8"><title>Ruukoto</title></head><body></body></html>';
    const sourceDir = path.join(root, "source");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, "index.html"), source);
    const plugin = productionCspPlugin();
    assert.equal(plugin.apply, "build");
    await build({
      root: sourceDir,
      configFile: false,
      logLevel: "silent",
      plugins: [plugin],
      build: { outDir: path.join(root, "renderer"), emptyOutDir: true },
    });
    assert.equal(fs.readFileSync(path.join(sourceDir, "index.html"), "utf8"), source);
    assert.doesNotThrow(() => checkBuild(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("桌面产物：解码后的严格 CSP、单文件 CJS 与内置模块引用可通过", () => {
  const root = fixture();
  try {
    assert.doesNotThrow(() => checkBuild(root));
    const result = spawnSync(process.execPath, [buildScript, root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("桌面产物：缺失、错位或开发 CSP 都阻断构建", () => {
  const root = fixture();
  try {
    for (const head of [
      '<meta charset="utf-8">',
      `<meta charset="utf-8">${cspMeta}`,
      `${cspMeta}<meta name="csp-nonce" content="development-nonce">`,
      `${cspMeta}<meta property="csp-nonce">`,
      `${cspMeta}<script nonce="development-nonce"></script>`,
      cspMeta.replace(encodedCsp, "default-src &apos;self&apos; &apos;unsafe-inline&apos;"),
    ]) {
      fs.writeFileSync(path.join(root, "renderer/index.html"), `<html><head>${head}</head><body></body></html>`);
      assert.throws(() => checkBuild(root), DesktopBuildError);
    }
    const result = spawnSync(process.execPath, [buildScript, root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[ruukoto:desktop\].*CSP/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("桌面产物：preload 必须是单个有效 CommonJS 文件", () => {
  const root = fixture();
  try {
    const preload = path.join(root, "preload/index.cjs");
    fs.writeFileSync(path.join(root, "preload/chunk.cjs"), "module.exports = {};");
    assert.throws(() => checkBuild(root), DesktopBuildError);
    fs.unlinkSync(path.join(root, "preload/chunk.cjs"));
    for (const source of ['import { contextBridge } from "electron";', "export default {};", "await Promise.resolve();"]) {
      fs.writeFileSync(preload, source);
      assert.throws(() => checkBuild(root), DesktopBuildError, source);
    }
    fs.renameSync(preload, path.join(root, "preload/index.js"));
    assert.throws(() => checkBuild(root), DesktopBuildError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("桌面产物：两个 Node 目标拒绝 workspace、缺失相对路径和未知动态外部引用", () => {
  for (const target of ["main/index.js", "preload/index.cjs"]) {
    const root = fixture();
    try {
      for (const source of [
        'require("@ruukoto/core/paths.ts");',
        'require("./chunk.cjs");',
        'require("node:nonexistent-builtin");',
        'import("@ruukoto/control/connection.ts");',
        'import("./chunk.js");',
        'import(moduleName);',
        'require(moduleName);',
        'export { value } from "unexpected-dependency";',
      ]) {
        fs.writeFileSync(path.join(root, target), source);
        assert.throws(() => checkBuild(root), DesktopBuildError, `${target}: ${source}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("终端运行依赖仅精确引用放行，native或helper缺失及不可执行阻断构建", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "main/index.js"), 'import pty from "./vendor/node-pty/lib/index.js";');
    assert.doesNotThrow(() => checkBuild(root));
    fs.writeFileSync(path.join(root, "preload/index.cjs"), 'require("./vendor/node-pty/lib/index.js");');
    assert.throws(() => checkBuild(root), DesktopBuildError);
    fs.writeFileSync(path.join(root, "preload/index.cjs"), 'require("electron");');
    const native = path.join(root, "main/vendor/node-pty/build/Release/pty.node");
    fs.renameSync(native, `${native}.held`); assert.throws(() => checkBuild(root), DesktopBuildError); fs.renameSync(`${native}.held`, native);
    if (process.platform === "darwin") {
      const helper = path.join(root, "main/vendor/node-pty/build/Release/spawn-helper");
      fs.chmodSync(helper, 0o644); assert.throws(() => checkBuild(root), DesktopBuildError); fs.chmodSync(helper, 0o755);
      fs.unlinkSync(helper); assert.throws(() => checkBuild(root), DesktopBuildError);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("宿主bootstrap只允许同目录已打包文件，符号链接不能绕过依赖检查", () => {
  const root = fixture();
  try {
    const chunk = path.join(root, "main/host.js");
    fs.writeFileSync(chunk, "export const value = 1;");
    fs.writeFileSync(path.join(root, "main/index.js"), 'import("./host.js");');
    assert.doesNotThrow(() => checkBuild(root));
    fs.unlinkSync(chunk);
    const outside = path.join(root, "outside.js");
    fs.writeFileSync(outside, "export const value = 2;");
    fs.symlinkSync(outside, chunk);
    assert.throws(() => checkBuild(root), DesktopBuildError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
