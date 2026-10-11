import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CommandHistoryStore } from "@ruukoto/tui/tui/command-history.ts";
import type { CommandEntry } from "@ruukoto/tui/tui/event-flow.ts";

const at = "2026-09-25T10:00:00.000Z";
const command = (key: string, extra: Partial<CommandEntry> = {}): CommandEntry => ({
  key, kind: "command", line: "/context", result: null, isError: false, at, seq: 0, ...extra,
});

test("命令立即持久化，独立客户端更新单条结果且保留顺序、隔离与全部历史", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-command-history-"));
  const file = path.join(root, "tui", "commands.sqlite");
  const first = new CommandHistoryStore(file);
  const second = new CommandHistoryStore(file);
  try {
    assert.deepEqual(first.load("instance", "session"), []);
    const earlier = command("earlier", { at: "2026-09-25T09:00:00.000Z", seq: 9 });
    const b = command("b", { seq: 1 });
    const a = command("a", { seq: 1, line: "/mode full_access" });
    const later = command("later", { seq: 2 });
    first.save("instance", "session", later);
    second.save("instance", "session", b);
    first.save("instance", "session", earlier);
    second.save("instance", "session", a);
    assert.deepEqual(new CommandHistoryStore(file).load("instance", "session"), [earlier, a, b, later]);

    const completed = { ...a, result: "Switched to Full access" };
    first.save("instance", "session", completed);
    second.save("instance", "session", { ...later, result: "命令失败", isError: true });
    assert.deepEqual(first.load("instance", "session"), [earlier, completed, b, { ...later, result: "命令失败", isError: true }]);
    first.save("other-instance", "session", command("a", { line: "/help" }));
    second.save("instance", "other-session", command("a", { line: "/status" }));
    assert.equal(first.load("other-instance", "session")[0]!.line, "/help");
    assert.equal(first.load("instance", "other-session")[0]!.line, "/status");
    assert.equal(first.load("instance", "session").length, 4);

    for (let i = 0; i < 64; i++) {
      (i % 2 ? first : second).save("instance", "session", command(`older:${i}`, { seq: i + 10 }));
    }
    assert.equal(new CommandHistoryStore(file).load("instance", "session").length, 68, "展示上限不删除持久命令");
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("两个 TUI 进程并发保存命令与结果，不覆盖其他进程的记录", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-command-concurrent-"));
  const file = path.join(root, "tui", "commands.sqlite");
  const source = `
    import { CommandHistoryStore } from ${JSON.stringify(new URL("../packages/tui/src/tui/command-history.ts", import.meta.url).href)};
    const store = new CommandHistoryStore(process.argv[1]);
    for (let i = 0; i < 32; i++) {
      const entry = { key: process.argv[2] + ':' + i, kind: 'command', line: '/mode', result: null,
        isError: false, at: ${JSON.stringify(at)}, seq: i };
      store.save('instance', 'session', entry);
      store.save('instance', 'session', { ...entry, result: 'saved ' + entry.key });
    }
  `;
  try {
    const results = await Promise.allSettled(["first", "second"].map((writer) =>
      promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, file, writer]),
    ));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const entries = new CommandHistoryStore(file).load("instance", "session");
    assert.equal(entries.length, 64);
    assert.equal(new Set(entries.map((entry) => entry.key)).size, 64);
    assert.ok(entries.every((entry) => entry.result === `saved ${entry.key}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("命令存储失败或文件损坏时抛错，不静默当作空历史", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-command-failure-"));
  try {
    const blocked = path.join(root, "blocked");
    fs.writeFileSync(blocked, "file");
    const unavailable = new CommandHistoryStore(path.join(blocked, "commands.sqlite"));
    assert.throws(() => unavailable.save("instance", "session", command("one")));
    assert.throws(() => unavailable.load("instance", "session"));
    const corrupt = path.join(root, "corrupt.sqlite");
    fs.writeFileSync(corrupt, "not a SQLite database");
    assert.throws(() => new CommandHistoryStore(corrupt).load("instance", "session"));
    assert.equal(fs.readFileSync(corrupt, "utf8"), "not a SQLite database");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
