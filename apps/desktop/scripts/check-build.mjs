import * as fs from "node:fs";
import * as path from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "parse5";
import ts from "typescript";
import { PRODUCTION_CSP } from "../build/security.mjs";

export class DesktopBuildError extends Error {
  code = "desktop_build_invalid";
}

function fail(message) {
  throw new DesktopBuildError(message);
}

function checkHtml(file) {
  const document = parse(fs.readFileSync(file, "utf8"));
  const html = document.childNodes.find((node) => node.tagName === "html");
  const head = html?.childNodes.find((node) => node.tagName === "head");
  const first = head?.childNodes.find((node) => node.tagName);
  const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
  if (first?.tagName !== "meta" || attr(first, "http-equiv")?.toLowerCase() !== "content-security-policy" || attr(first, "content") !== PRODUCTION_CSP) {
    fail("renderer/index.html 的 head 首个元素必须是生产 CSP meta。");
  }
  const visit = (node) => {
    if ((node.tagName === "meta" && ["name", "property"].some((name) => attr(node, name)?.toLowerCase() === "csp-nonce")) || node.attrs?.some((item) => item.name === "nonce")) {
      fail("renderer/index.html 含有开发 nonce，请检查 Vite 的 serve/build 配置。");
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  };
  visit(document);
}

function checkJavaScript(file, preload) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const checkModule = (node) => {
    if (!node || !ts.isStringLiteralLike(node) || (node.text !== "electron" && !isBuiltin(node.text))) {
      fail(`${file} 含有未打包的依赖；外部引用只允许 electron 与 Node 内置模块。`);
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (preload) fail("preload/index.cjs 必须是 CommonJS，不能含 ESM import/export。");
      if (node.moduleSpecifier) checkModule(node.moduleSpecifier);
    }
    if (preload && ts.isExportAssignment(node)) fail("preload/index.cjs 必须是 CommonJS，不能含 ESM export。");
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      checkModule(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (preload) {
    const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (syntax.error) throw syntax.error;
    if (syntax.status !== 0) fail("preload/index.cjs 不是有效的 CommonJS 文件，请检查 preload 输出格式。");
  }
}

export function checkBuild(outDir = fileURLToPath(new URL("../out", import.meta.url))) {
  checkHtml(path.join(outDir, "renderer", "index.html"));
  const preloadDir = path.join(outDir, "preload");
  const entries = fs.readdirSync(preloadDir, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== "index.cjs" || !entries[0].isFile()) {
    fail("preload 产物必须仅有一个 index.cjs 文件。");
  }
  checkJavaScript(path.join(preloadDir, "index.cjs"), true);
  const checkMain = (directory) => {
    let checked = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) checked += checkMain(file);
      else if (/\.(?:c|m)?js$/.test(entry.name)) {
        checkJavaScript(file, false);
        checked++;
      } else if (/\.(?:c|m)?tsx?$/.test(entry.name)) fail("main 产物含未打包的 TypeScript 源码。");
    }
    return checked;
  };
  if (checkMain(path.join(outDir, "main")) === 0) fail("main 产物缺少 JavaScript 入口。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    checkBuild(process.argv[2]);
  } catch (error) {
    process.stderr.write(`[ruukoto:desktop] 桌面构建产物检查失败：${error instanceof Error ? error.message : String(error)} 请修正构建配置后重新运行 desktop:build。\n`);
    process.exitCode = 1;
  }
}
