/**
 * 斜杠命令条目（架构工单 06）：表的一致性、派发规则与只拿上下文的处理函数。
 * 假上下文：请求只记 op 与参数、返回预设应答；host 只记调用。不起终端与 Runtime。
 */

import * as fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMANDS,
  SlashCommandAutocomplete,
  VISIBLE_COMMANDS,
  commandHelpLines,
  dispatchInput,
  LEGACY_PROJECT_WRITE_HINT,
  type CommandEnv,
  type CommandHost,
  type CommandResult,
} from "../src/tui/commands.ts";
import { ControlClientError } from "../src/control/client.ts";
import type { OpParams, OpResult, TuiOp } from "../src/control/ops.ts";

type Reply = unknown | Error | ((params: Record<string, unknown> | undefined) => unknown);

/** 预设应答按 op 名登记（名字须在 op 表里；形状只按各测试所需手写）。 */
function fake(opts: { view?: CommandEnv["view"]; replies?: Partial<Record<TuiOp, Reply>>; hostReturns?: Partial<Record<keyof CommandHost, unknown>> } = {}) {
  const log = {
    requests: [] as Array<[string, Record<string, unknown> | undefined]>,
    notes: [] as string[],
    texts: [] as string[],
    echoes: [] as string[],
    results: [] as Array<[string | null, string, boolean]>,
    host: [] as Array<[string, ...unknown[]]>,
  };
  const host = new Proxy({} as CommandHost, {
    get: (_target, name) => async (...args: unknown[]) => {
      log.host.push([String(name), ...args]);
      return opts.hostReturns?.[name as keyof CommandHost];
    },
  });
  const env: CommandEnv = {
    view: opts.view === undefined ? { sessionId: "sess_1", projectId: "proj_1" } : opts.view,
    request: async <K extends TuiOp>(op: K, params: OpParams<K>) => {
      log.requests.push([op, params]);
      const reply = opts.replies?.[op];
      if (reply instanceof Error) throw reply;
      return (typeof reply === "function" ? reply(params) : reply) as OpResult<K>;
    },
    notify: (text) => log.notes.push(text),
    showText: (text) => log.texts.push(text),
    echo: (line) => {
      log.echoes.push(line);
      return `command:${log.echoes.length}`;
    },
    setResult: (key, text, isError) => log.results.push([key, text, isError]),
    host,
  };
  return { env, log, run: (text: string) => dispatchInput(text, env) };
}

// ---------- 表 ----------

test("命令表：名字唯一；补全与帮助只列可见条目；已删除命令不再派发", async () => {
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, "名字唯一");
  assert.deepEqual(COMMANDS.filter((c) => c.hidden).map((c) => c.name), []);

  const help = commandHelpLines();
  assert.deepEqual(help.map((l) => /^  \/(\S+)/.exec(l)![1]), VISIBLE_COMMANDS.map((c) => c.name));
  assert.ok(help.includes("  /memory <子命令> — 长期记忆"));

  const complete = new SlashCommandAutocomplete(VISIBLE_COMMANDS);
  const all = await complete.getSuggestions(["/"], 0, 1);
  assert.deepEqual(all!.items.map((i) => i.value), VISIBLE_COMMANDS.map((c) => `/${c.name}`));
  assert.equal(await complete.getSuggestions(["/gi"], 0, 3), null, "隐藏命令不补全");

  const f = fake();
  await f.run("/github");
  assert.deepEqual(f.log.echoes, ["/github"]);
  assert.match(f.log.notes[0]!, /未知命令：\/github/);
});

test("README 命令表：第一列列出的 /名字 与可见条目正好一致", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const table = readme.slice(readme.indexOf("**命令**"), readme.indexOf("**断开与重连**"));
  const names = table
    .split("\n")
    .filter((l) => l.startsWith("| `/"))
    .flatMap((l) => [...l.split("|")[1]!.matchAll(/`\/([a-z-]+)/g)].map((m) => m[1]!));
  assert.deepEqual(names.sort(), VISIBLE_COMMANDS.map((c) => c.name).sort());
});

// ---------- 派发 ----------

test("派发：/quit 不回显；未知命令回显并注记；空输入无动作；普通文本原样提交", async () => {
  const f = fake();
  await f.run("/quit");
  assert.deepEqual(f.log.echoes, []);
  assert.deepEqual(f.log.host, [["quit"]]);

  await f.run("/nope  x");
  assert.deepEqual(f.log.echoes, ["/nope  x"]);
  assert.deepEqual(f.log.notes, ["未知命令：/nope（/help 查看命令列表）"]);

  await f.run("   ");
  await f.run("  你好\n世界  ");
  assert.deepEqual(f.log.host.slice(1), [["submit", "  你好\n世界  "]]);
  assert.equal(f.log.echoes.length, 1);
});

test("派发：/plan <内容> 作任务输入不回显；只输入 /plan 显示用法并回显", async () => {
  const f = fake();
  await f.run("  /plan 调研  登录 ");
  assert.deepEqual(f.log.host, [["submit", "/plan 调研  登录"]]);
  assert.deepEqual(f.log.echoes, []);

  await f.run("/plan");
  assert.deepEqual(f.log.echoes, ["/plan"]);
  assert.match(f.log.notes[0]!, /^用法：\/plan <内容>/);
  assert.equal(f.log.host.length, 1);
});

test("派发：/skill <名称> 与 /skill:<名称> 都作任务输入不回显，按 trim 过的整行提交参数原文；不带名称列出技能库", async () => {
  const f = fake({ replies: { list_skills: { dir: "/s", skills: [], diagnostics: [] } } });
  await f.run("/skill review  a\nb");
  await f.run("/skill\nreview x");
  await f.run("  /skill:review x ");
  assert.deepEqual(f.log.host, [["submit", "/skill:review  a\nb"], ["submit", "/skill:review x"], ["submit", "/skill:review x"]]);
  assert.deepEqual(f.log.echoes, [], "任务输入不回显");

  await f.run("/skill  ");
  assert.deepEqual(f.log.requests, [["list_skills", {}]]);
  assert.deepEqual(f.log.echoes, ["/skill"]);
  await f.run("/skills:x");
  assert.deepEqual(f.log.notes.at(-1), "未知命令：/skills:x（/help 查看命令列表）");
});

test("/status：没有活动任务时注记；有活动任务时只刷新", async () => {
  const idle = fake({ hostReturns: { refreshTask: false } });
  await idle.run("/status");
  assert.deepEqual(idle.log.notes, ["当前没有活动任务"]);
  const busy = fake({ hostReturns: { refreshTask: true } });
  await busy.run("/status");
  assert.deepEqual(busy.log.host, [["refreshTask"]]);
  assert.deepEqual(busy.log.notes, []);
});

test("派发：成功结果由 keepsResult 条目保留；错误总是保留", async () => {
  const f = fake();
  const resultOf = async (line: string): Promise<CommandResult> => {
    await f.run(line);
    const call = f.log.host.at(-1)!;
    return call.at(-1) as CommandResult;
  };
  (await resultOf("/model"))("Switched to a/b · off");
  (await resultOf("/mode"))("Switched to Full access");
  const context = await resultOf("/context");
  context("上下文查询失败：x", true);
  assert.deepEqual(f.log.results, [
    ["command:1", "Switched to a/b · off", false],
    ["command:2", "Switched to Full access", false],
    ["command:3", "上下文查询失败：x", true],
  ]);

  await f.run("/mode full_access");
  assert.deepEqual(f.log.host.at(-1)!.slice(0, 2), ["openModeList", ["full_access"]]);
});

test("派发：参数按空白切分，arg 合并空白；面板类命令转交 host", async () => {
  const f = fake({ replies: { search_history: { hits: [], complete: true, scanned: 0 } } });
  await f.run("/search  a   b ");
  assert.deepEqual(f.log.requests, [["search_history", { query: "a b", session_id: "sess_1", limit: 20 }]]);
  await f.run("/cancel task_1");
  await f.run("/expand abc");
  await f.run("/status");
  assert.deepEqual(f.log.host, [["cancel", "task_1"], ["refreshTask"]]);
  assert.ok(f.log.notes.some((note) => /未知命令：\/expand/.test(note)));
});

test("/resume 和 /project 派发到对应窗口，/sessions 不再存在", async () => {
  const f = fake();
  await f.run("/resume");
  await f.run("/project");
  await f.run("/sessions");
  assert.deepEqual(f.log.host, [["openResume"], ["openProjects"]]);
  assert.ok(f.log.notes.includes("未知命令：/sessions（/help 查看命令列表）"));
  assert.ok(!VISIBLE_COMMANDS.some((command) => command.name === "sessions"));
});

// ---------- 只拿上下文的处理函数 ----------

test("/memory：list（带项目 / 无会话）、show、revoke / restore 的版本号校验与请求", async () => {
  const memories = [{ id: "mem_0123456789ab", category: "偏好", status: "active", currentVersion: 2, scope: "personal", updatedAt: "2026-09-27" }];
  const f = fake({
    replies: {
      list_memories: { memories },
      get_memory: {
        memory: { id: "mem_1", category: "偏好", status: "active", currentVersion: 2, content: "用中文", sourceRefs: [] },
        versions: [{ version: 1, author: "agent", reason: "", createdAt: "t1" }, { version: 2, author: "owner", reason: "改写", createdAt: "t2" }],
      },
      revoke_memory: {},
      restore_memory: new ControlClientError("invalid_params", "版本不存在", "rejected"),
    },
  });
  await f.run("/memory");
  assert.deepEqual(f.log.requests.at(-1), ["list_memories", { project_id: "proj_1" }]);
  assert.equal(f.log.texts.at(-1), "记忆（1 条）：\n  [mem_012345] 偏好 v2 active（个人共享）  2026-09-27\n/memory show <id> 查看正文与版本");

  await f.run("/memory show");
  assert.equal(f.log.notes.at(-1), "用法：/memory show <id>");
  await f.run("/memory show mem_1");
  assert.deepEqual(f.log.requests.at(-1), ["get_memory", { memory_id: "mem_1" }]);
  assert.equal(f.log.texts.at(-1), "记忆 mem_1（偏好，active，当前 v2）：\n用中文\n版本历史：\n  v1 agent t1\n  v2 owner t2（改写）");

  const before = f.log.requests.length;
  await f.run("/memory revoke mem_1");
  await f.run("/memory revoke mem_1 v2");
  await f.run("/memory restore mem_1");
  assert.equal(f.log.requests.length, before, "版本号缺失或非数字不发请求");
  assert.match(f.log.notes.at(-3)!, /^用法：\/memory revoke <id> <当前版本号>/);
  assert.match(f.log.notes.at(-1)!, /^用法：\/memory restore <id> <恢复自版本号>/);

  await f.run("/memory revoke mem_1 2");
  assert.deepEqual(f.log.requests.at(-1), ["revoke_memory", { memory_id: "mem_1", expected_version: 2 }]);
  assert.match(f.log.texts.at(-1)!, /^记忆 mem_1 已撤销/);
  await f.run("/memory restore mem_1 1");
  assert.deepEqual(f.log.requests.at(-1), ["restore_memory", { memory_id: "mem_1", from_version: 1 }]);
  assert.equal(f.log.notes.at(-1), "\x1b[31m恢复记忆失败：版本不存在\x1b[0m");

  await f.run("/memory purge");
  assert.match(f.log.notes.at(-1)!, /^用法：\/memory \[list/);

  const empty = fake({ view: null, replies: { list_memories: { memories: [] } } });
  await empty.run("/memory list");
  assert.deepEqual(empty.log.requests, [["list_memories", {}]]);
  assert.match(empty.log.texts[0]!, /^当前项目没有记忆/);
});

test("/qq：未配置、已配置、启停、inbox 空与非空、未知子命令、请求失败", async () => {
  const status = {
    configured: true, enabled: true, online: false, stateDetail: "未连接", endpoint: "ws://x", selfId: "10", actualSelfId: null,
    configVersion: 3, groups: ["100", "200"], ownerUserId: null, maxReplyChars: 500,
    sessions: [{ groupId: "100", sessionId: "sess_abcdefghijk", queued: 2, active: true }],
  };
  const f = fake({
    replies: {
      qq_status: status,
      qq_set_enabled: (p: any) => ({ configVersion: p.enabled ? 4 : 5 }),
      qq_inbox_list: { entries: [] },
      qq_outbox_list: { entries: [{ groupId: "100", text: "你好", status: "failed", error: "超时", createdAt: "t1" }] },
    },
  });
  await f.run("/qq");
  assert.deepEqual(f.log.requests.at(-1), ["qq_status", {}]);
  assert.equal(
    f.log.texts.at(-1),
    "QQ 入口：已启用；连接 离线（未连接）\n端点 ws://x；预期账号 10；配置 v3；允许群：100、200（历史值，核心群聊已退役）\n" +
      "拥有者私聊：未开启（共享 main；发送记录用 ruukoto notify list 查看）\n旧群会话归档：\n" +
      "  群 100：会话 sess_abcde… 排队 2，执行中",
  );
  await f.run("/qq disable");
  assert.deepEqual(f.log.requests.at(-1), ["qq_set_enabled", { enabled: false }]);
  assert.equal(f.log.texts.at(-1), "QQ 入口已停用（配置 v5）");
  await f.run("/qq groups");
  assert.equal(f.log.texts.at(-1), "允许的群：100、200（历史值）\n核心群聊已退役，不再维护允许群（正式 QQ 群聊外挂将在后续阶段交付）");
  await f.run("/qq inbox 100");
  assert.deepEqual(f.log.requests.at(-1), ["qq_inbox_list", { group_id: "100", limit: 20 }]);
  assert.equal(f.log.texts.at(-1), "暂无收件登记");
  await f.run("/qq outbox");
  assert.equal(f.log.texts.at(-1), "发送记录（最近 1 条）：\n  群 100：你好 [failed] 超时 t1");
  await f.run("/qq wat");
  assert.match(f.log.notes.at(-1)!, /^用法：\/qq \[status/);

  const unconfigured = fake({ replies: { qq_status: { configured: false } } });
  await unconfigured.run("/qq status");
  assert.match(unconfigured.log.texts[0]!, /^QQ 入口未配置/);
  // 适配器未启动（dev 实例）：回退形状没有群与会话
  const idle = fake({ replies: { qq_status: { configured: true, enabled: false, online: false, stateDetail: "适配器未启动" } } });
  await idle.run("/qq");
  await idle.run("/qq groups");
  assert.deepEqual(idle.log.texts, ["QQ 入口已配置；适配器未启动", "允许的群：（空）（历史值）\n核心群聊已退役，不再维护允许群（正式 QQ 群聊外挂将在后续阶段交付）"]);
  const broken = fake({ replies: { qq_status: new Error("连接断开") } });
  await broken.run("/qq");
  assert.match(broken.log.notes[0]!, /QQ 操作失败：连接断开/);
  const lost = fake({ replies: { qq_set_enabled: new ControlClientError("connection_closed", "连接已关闭", "disconnected") } });
  await lost.run("/qq disable");
  assert.match(lost.log.notes[0]!, /QQ 入口停用结果未知：连接已关闭；先用 \/qq 核实再操作（未自动重发）/);
  assert.deepEqual(lost.log.texts, [], "结果未知时不宣称已停用");
});

test("/search：无会话、无关键词、无命中（不完整）、有命中；请求失败", async () => {
  const none = fake({ view: null });
  await none.run("/search x");
  assert.deepEqual(none.log.notes, ["尚未选择会话"]);
  assert.equal(none.log.requests.length, 0);

  const f = fake({
    replies: {
      search_history: (p: any) =>
        p.query === "空"
          ? { hits: [], complete: false, scanned: 40 }
          : { hits: [{ entryId: "entry_123456789", role: "user", timestamp: null, snippet: "登录\n失败", matchCount: 2 }], complete: true, scanned: 9 },
    },
  });
  await f.run("/search");
  assert.match(f.log.notes[0]!, /^用法：\/search <关键词>/);
  await f.run("/search 空");
  assert.equal(f.log.texts.at(-1), "没有命中：「空」（扫描 40 条，结果不完整）");
  await f.run("/search 登录");
  assert.equal(f.log.texts.at(-1), "命中 1 条（扫描 9 条）：\n  [entry_12] user ×2  登录 失败");

  const broken = fake({ replies: { search_history: new Error("超时") } });
  await broken.run("/search x");
  assert.match(broken.log.notes[0]!, /搜索失败：超时/);
});

test("/skills：列表与诊断；/new-project：用法、成功、失败", async () => {
  const f = fake({
    replies: {
      list_skills: { dir: "/home/s", skills: [{ name: "review", explicitOnly: true, description: "代码审查" }], diagnostics: ["bad/SKILL.md：缺少 name"] },
      create_project: (p: any) => {
        if (p.name === "坏") throw new ControlClientError("duplicate", "名称重复", "rejected");
        if (p.name === "慢") throw new ControlClientError("request_timeout", "请求超时：create_project", "unknown");
        if (p.name === "断") throw new ControlClientError("connection_unavailable", "连接不可用：请求未发送", "not_sent");
        return { id: "proj_2" };
      },
    },
  });
  await f.run("/skills");
  assert.equal(
    f.log.texts.at(-1),
    "技能库 /home/s（1 个；修改从下一任务生效）\n  review（仅显式调用）  代码审查\n诊断（1 条）：\n  bad/SKILL.md：缺少 name\n/skill <名称> [参数] 显式调用",
  );

  await f.run("/new-project");
  assert.equal(f.log.notes.at(-1), "用法：/new-project <名称>");
  await f.run("/new-project 家务  清单");
  assert.deepEqual(f.log.requests.at(-1), ["create_project", { name: "家务 清单" }]);
  assert.equal(f.log.texts.at(-1), "项目已创建：家务 清单；用 /new-session <工作目录> 创建会话");
  await f.run("/new-project 坏");
  assert.match(f.log.notes.at(-1)!, /创建项目失败：名称重复/);
  // 写操作失败按分类提示：应答丢失时可能已生效，不自动重发，指明核实入口
  await f.run("/new-project 慢");
  assert.match(f.log.notes.at(-1)!, /创建项目结果未知：请求超时：create_project；先用 \/project 核实再操作（未自动重发）/);
  await f.run("/new-project 断");
  assert.match(f.log.notes.at(-1)!, /创建项目未发送：连接不可用/);
  assert.equal(f.log.requests.filter(([op]) => op === "create_project").length, 4, "都只发一次");

  // ruukoto-dev 不再提供旧项目写入路径（agent-direction issue 23）：只提示工作区入口，不发请求
  const saved = process.env.RUUKOTO_PRODUCT;
  process.env.RUUKOTO_PRODUCT = "ruukoto-dev";
  try {
    await f.run("/new-project 新");
    assert.equal(f.log.notes.at(-1), LEGACY_PROJECT_WRITE_HINT);
    assert.equal(f.log.requests.filter(([op]) => op === "create_project").length, 4);
  } finally {
    if (saved === undefined) delete process.env.RUUKOTO_PRODUCT;
    else process.env.RUUKOTO_PRODUCT = saved;
  }
});
