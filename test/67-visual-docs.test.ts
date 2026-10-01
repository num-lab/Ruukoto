/**
 * 可视化文档检查（docs/visual/*.html）：页面随代码长期维护，这里拦下代码结构变了而页面没跟上。
 *
 * 1. 源码锚点：每个 data-src 指向的文件存在，且 # 之后的文本逐字出现在该文件里；
 * 2. 覆盖：源码里的状态、表、op、事件类型等取值，对应页面的 <code> 里逐字出现；
 * 3. index.html 链接到每个页面。
 *
 * 只核对「提到了」，不核对说得对不对；维护规则见 AGENTS.md「可视化文档」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = "docs/visual";

/** 页面 → 必须覆盖的取值来源（文件#类型名 / 常量名 / 目录名）。 */
const COVERAGE: Record<string, string[]> = {
  "task-lifecycle.html": ["src/core/types.ts#TaskStatus", "src/core/types.ts#SessionQueueState"],
  "tool-call-path.html": [
    "src/core/types.ts#AccessMode",
    "src/core/types.ts#ApprovalScope",
    "src/core/types.ts#ToolCategory",
    "src/core/types.ts#ConfirmationStatus",
    "src/agent/review.ts#ReviewDecision",
  ],
  "context-pipeline.html": [
    "src/agent/context-selector.ts#CONTEXT_CATEGORIES",
    "src/agent/context-selector.ts#SELECTOR_STRATEGY",
    "src/agent/compaction.ts#COMPACTION_PROMPT_VERSION",
    "src/core/types.ts#MemoryCategory",
    "src/core/types.ts#DataCategory",
  ],
  "storage-layout.html": ["src/core/db.ts#tables", "src/agent/app-data/store.ts#tables", "src/core/db.ts#SCHEMA_VERSION"],
  "control-protocol.html": [
    "src/control/server.ts#ops",
    "src/core/types.ts#PROTOCOL_VERSION",
    "src/control/client.ts#RequestOutcome",
    "src/core/types.ts#events",
  ],
  "deployment.html": ["src/agent/managed-processes.ts#ManagedUnitKind"],
  "orchestrator.html": ["src/core/types.ts#AgentRoleId", "src/core/types.ts#events:child_task."],
  "inbound-events.html": [
    "src/core/types.ts#InboundEventStatus",
    "src/qq/store.ts#QqInboxStatus",
    "src/telegram/adapter.ts#TELEGRAM_SOURCE",
    "src/qq/store.ts#QQ_GROUP_SOURCE",
    "src/qq/adapter.ts#QQ_PRIVATE_SOURCE",
    "src/github/webhook.ts#GITHUB_SOURCE",
  ],
  "outbox.html": [
    "src/scheduler/store.ts#NotificationStatus",
    "src/scheduler/store.ts#NotificationSourceKind",
    "src/scheduler/store.ts#ScheduleStatus",
    "src/scheduler/store.ts#ScheduleAction",
    "src/qq/store.ts#QqOutboxStatus",
  ],
  "once-only.html": [],
};

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const unique = (values: string[]) => [...new Set(values)];

/** 源码片段：从 start 起到其后第一个 end 为止。 */
function slice(rel: string, start: string, end: string): string {
  const text = read(rel);
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${rel} 里找不到 ${start} … ${end}（源码结构变了，请同步本测试）`);
  return text.slice(from, to);
}

const literals = (text: string, re: RegExp) => unique([...text.matchAll(re)].map((m) => m[1]!));

/** 一个来源展开成具体取值；解析不出任何值视为失败，防止检查悄悄失效。 */
function valuesOf(ref: string): string[] {
  const [rel, spec] = ref.split("#") as [string, string];
  let values: string[];
  if (spec === "tables") {
    values = literals(read(rel), /CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g).filter((t) => !t.endsWith("_new"));
  } else if (spec === "ops") {
    values = literals(slice(rel, "switch (request.op)", "default:"), /case "([a-z_]+)":/g);
  } else if (spec.startsWith("events")) {
    const prefix = spec.split(":")[1] ?? "";
    values = literals(slice(rel, "export type PersistentEventBody", "export interface PersistentEvent"), /type: "([a-z_.]+)"/g)
      .filter((t) => !t.startsWith("github.") && t.startsWith(prefix)); // github.* 已退役，只读归档
  } else if (spec === "ApprovalScope") {
    values = literals(slice(rel, "export type ApprovalScope", "export interface"), /kind: "([a-z_]+)"/g);
  } else if (spec === "CONTEXT_CATEGORIES") {
    values = literals(slice(rel, "const CONTEXT_CATEGORIES = {", "} as const"), /^\s*([A-Za-z]+):/gm);
  } else if (/^[A-Z][A-Z0-9_]*$/.test(spec)) {
    const m = new RegExp(String.raw`export const ${spec}\s*=\s*("?)([^";\n]+)\1;`).exec(read(rel));
    assert.ok(m, `${rel} 里找不到 export const ${spec}`);
    values = [m[1] ? m[2]! : `v${m[2]}`]; // 数字常量是版本号，页面写成 v18 / v9
  } else {
    values = literals(slice(rel, `export type ${spec} =`, ";"), /"([^"]+)"/g);
  }
  assert.ok(values.length > 0, `${ref} 没有解析出任何取值`);
  return values;
}

const htmlPages = () => fs.readdirSync(path.join(ROOT, DOCS)).filter((f) => f.endsWith(".html")).sort();
const decode = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

test("可视化文档：源码锚点指向存在的文件与文本", () => {
  let anchors = 0;
  const broken: string[] = [];
  for (const page of htmlPages()) {
    for (const [, raw] of read(`${DOCS}/${page}`).matchAll(/data-src="([^"]+)"/g)) {
      const [rel, ...rest] = decode(raw!).split("#");
      const symbol = rest.join("#");
      anchors++;
      if (!fs.existsSync(path.join(ROOT, rel!))) broken.push(`${page}：${rel} 不存在`);
      else if (symbol && !read(rel!).includes(symbol)) broken.push(`${page}：${rel} 里找不到「${symbol}」`);
    }
  }
  assert.ok(anchors > 0, "没有找到任何源码锚点");
  assert.deepEqual(broken, [], "源码改名、移动或删除后请同步页面");
});

test("可视化文档：页面覆盖源码里的状态、表、op 与事件", () => {
  const missing: string[] = [];
  for (const [page, refs] of Object.entries(COVERAGE)) {
    if (!fs.existsSync(path.join(ROOT, DOCS, page))) {
      missing.push(`${page}：页面不存在`);
      continue;
    }
    const codes = [...read(`${DOCS}/${page}`).matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)].map((m) => decode(m[1]!)).join("\n");
    for (const ref of refs) {
      for (const v of valuesOf(ref)) {
        if (!new RegExp(`(?<![\\w.-])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`).test(codes)) missing.push(`${page}：${v}（${ref}）`);
      }
    }
  }
  assert.deepEqual(missing, [], "代码里新增或改名的取值，请在对应页面的 <code> 里提到");
});

test("可视化文档：index.html 链接每个页面", () => {
  const index = read(`${DOCS}/index.html`);
  const unlinked = htmlPages().filter((p) => p !== "index.html" && !index.includes(`href="${p}"`));
  assert.deepEqual(unlinked, []);
  assert.deepEqual(Object.keys(COVERAGE).filter((p) => !htmlPages().includes(p)), [], "COVERAGE 里的页面都应存在");
});
