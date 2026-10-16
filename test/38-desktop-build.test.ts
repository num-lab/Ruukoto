import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { build } from "vite";
import { checkBuild, DesktopBuildError } from "../apps/desktop/scripts/check-build.mjs";
import { PRODUCTION_CSP, productionCspPlugin } from "../apps/desktop/build/security.mjs";

const encodedCsp = PRODUCTION_CSP.replaceAll("'", "&#39;");
const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${encodedCsp}">`;
const buildScript = path.resolve(import.meta.dirname, "../apps/desktop/scripts/check-build.mjs");

test("桌面生产 CSP 仅给内置浏览器开放 HTTP(S)，预览图片允许 data 而不开放脚本或本机 frame", () => {
  assert.match(PRODUCTION_CSP, /(?:^|;)\s*default-src 'self'(?:;|$)/);
  assert.match(PRODUCTION_CSP, /(?:^|;)\s*frame-src http: https:(?:;|$)/);
  assert.match(PRODUCTION_CSP, /(?:^|;)\s*img-src 'self' data:(?:;|$)/);
  assert.ok(!PRODUCTION_CSP.includes("unsafe-inline"));
  assert.ok(!PRODUCTION_CSP.includes("unsafe-eval"));
  assert.ok(!PRODUCTION_CSP.includes("file:"));
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-desktop-build-"));
  for (const directory of ["renderer", "main", "preload"]) fs.mkdirSync(path.join(root, directory));
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

test("桌面产物：两个 Node 目标拒绝 workspace、相对路径和未知动态外部引用", () => {
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
