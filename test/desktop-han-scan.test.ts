// Scans Desktop-owned sources for Han characters outside comments: desktop UI
// copy is English (see .agents/notes/implemented/feature/2026-11-08-desktop-english-ui.md).
// Allowlist = frozen-demo files plus model-facing strings returned to the
// control backend as command results (they can become Agent tool results).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const HAN = /[一-鿿]/;

const sources = (): string[] => {
  const files: string[] = [];
  const walk = (dir: string, include: (name: string) => boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, include);
      else if (include(entry.name)) files.push(full);
    }
  };
  for (const dir of ["renderer", "main", "preload", "shared"]) walk(`apps/desktop/src/${dir}`, name => /\.(ts|tsx|js)$/.test(name));
  walk("apps/desktop/mygo", name => /\.go$/.test(name) && !name.endsWith("_test.go") || name === "preload.js");
  return files;
};

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// Whole-file allowlist.
const filesAllowed = new Set([
  "apps/desktop/src/renderer/source-highlighting.ts", // frozen-demo byte identity
  "apps/desktop/src/renderer/components/ui/code-block.tsx", // frozen-demo byte identity
]);

// Per-string allowlist: file → exact Han-containing literals kept on purpose.
const stringsAllowed = new Map<string, string[]>([
  // Command results returned to the control backend; they can become Agent tool results.
  ["apps/desktop/src/main/browser-bridge.ts", [
    "`不支持的桌面浏览器请求：${op}`",
    '"浏览器命令缺少操作。"',
    '"浏览器结果超过内联上限，未送达；请缩小范围后重试。"',
    '"控制连接不可用，传输未发送。"',
    "`浏览器传输发送失败：${error instanceof Error ? error.message : String(error)}`",
  ]],
  // Node→Go transport failures are returned for both owner ops and server-originated commands.
  ["apps/desktop/mygo/transport.go", [
    '"MyGo 连接已关闭；请重新打开应用，原操作结果仍需核实。"',
    '"MyGo 连接不可用，请重新打开应用后核实原操作。"',
    '"MyGo 请求无法编码或超过大小限制，操作未发送。"',
    '"MyGo 请求未交付，操作未发送。"',
    '"MyGo 请求未能取得应答；请核实原操作，勿重复发送。"',
  ]],
  // browser_command dispatch failures return to the server.
  ["apps/desktop/mygo/main.go", [
    '"未知的子进程请求。"',
    '"浏览器命令缺少操作或输入。"',
  ]],
  // browser.Manager command-path failures are Agent tool results.
  ["apps/desktop/mygo/browser/browser.go", [
    '"原任务仍在使用此页面。"',
    '"导航目标必须是 HTTP(S) 地址。"',
    '"无效的 HTTP(S) 地址"',
    '"未知的浏览器命令。"',
    '"桌面窗口已关闭。"',
    '"桌面窗口未应答；请核实原操作。"',
    '"此浏览器任务已结束。"',
    '"此浏览器操作已不属于当前任务。"',
    '"浏览器请求已取消。"',
    '"浏览器连接已改变，原操作未发送。"',
    '"该会话没有浏览器页面。"',
    '"页面代次已过期，请重新观察。"',
    '"页面未由 Agent 持有。"',
    '"页面正由拥有者持有；请先交还。"',
    '"页面渲染已失效；请重新打开。"',
  ]],
]);

describe("desktop Han scan", () => {
  test("no Han characters outside comments and the allowlist", () => {
    const failures: string[] = [];
    for (const file of sources()) {
      if (filesAllowed.has(file)) continue;
      const stripped = stripComments(readFileSync(file, "utf8"));
      if (!HAN.test(stripped)) continue;
      const allowed = new Set(stringsAllowed.get(file) ?? []);
      for (const match of stripped.matchAll(/"[^"\n]*"|`[^`]*`|'[^'\n]*'/g)) {
        if (HAN.test(match[0]) && !allowed.has(match[0])) failures.push(`${file}: ${match[0]}`);
      }
      // JSX text between tags.
      for (const match of stripped.matchAll(/>([^<>"'`{}]+)</g)) {
        if (HAN.test(match[1])) failures.push(`${file}: JSX ${match[1].trim()}`);
      }
    }
    assert.deepEqual(failures, []);
  });
});
