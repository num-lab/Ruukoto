import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "@ruukoto/core/types.ts";
import { parseSlashInput, slashChoices, slashCommands, slashMenuKey } from "../apps/desktop/src/renderer/slash-commands.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";

test("Desktop recognizes only complete registered tokens and leaves slash paths unchanged", () => {
  assert.deepEqual(slashCommands.map(command => command.name), ["skill", "skills", "model", "mode", "new", "branch", "compact", "help"]);
  for (const text of ["/Users/example/file.txt", "/tmp", "/model.json", "/helpful", "/new/path", " /help", "ordinary\n/help"]) assert.equal(parseSlashInput(text), null, text);
  for (const name of ["help", "new", "model", "mode", "skills"]) {
    assert.deepEqual(parseSlashInput(`/${name}`), { kind: "command", name, arguments: "" });
    const invalid = parseSlashInput(`/${name} invalid`);
    assert.ok(invalid?.kind === "command" && invalid.error?.includes("does not accept arguments"));
  }
  assert.deepEqual(parseSlashInput("/branch my branch"), { kind: "command", name: "branch", arguments: "my branch" });
  assert.deepEqual(parseSlashInput("/compact keep API details\n  including failures\n"), { kind: "command", name: "compact", arguments: "keep API details\n  including failures\n" });
});

test("Desktop explicit skills normalize only their prefix and preserve multiline argument bytes", () => {
  for (const suffix of ["", " arguments", "  a\n\nb\n", "\n  /Users/example/file.txt\n"]) {
    for (const prefix of ["/skill ", "/skill   ", "/skill\n"]) assert.deepEqual(parseSlashInput(`${prefix}example${suffix}`), { kind: "skill", input: `/skill:example${suffix}` });
    assert.deepEqual(parseSlashInput(`/skill:example${suffix}`), { kind: "skill", input: `/skill:example${suffix}` });
  }
  assert.deepEqual(parseSlashInput("/skill"), { kind: "command", name: "skill", arguments: "" });
  const invalid = parseSlashInput("/skill:");
  assert.ok(invalid?.kind === "command" && invalid.error);
});

test("Desktop menu filters applicable commands and skill names without executing a choice", () => {
  assert.equal(slashChoices("ordinary /", [], () => true), null);
  assert.equal(slashChoices("/compact guidance\nmore", [], () => true), null);
  assert.deepEqual(slashChoices("/", [], name => name === "help")?.map(choice => choice.value), ["/help"]);
  assert.deepEqual(slashChoices("/mo", [], () => true)?.map(choice => choice.value), ["/model", "/mode"]);
  for (const command of slashCommands) assert.equal(slashChoices(`/${command.name}`, [], () => true)?.[0].value.trim(), `/${command.name}`);
  assert.equal(slashChoices("/he", [], () => true)?.[0].value, "/help");
  assert.deepEqual(slashChoices("/skill ex", [{ name: "example", description: "A skill" }, { name: "other", description: "Other" }], () => true), [{ value: "/skill example ", label: "example", description: "A skill" }]);
  assert.deepEqual(slashChoices("/skill:EX", [{ name: "example", description: "A skill" }], () => true)?.map(choice => choice.value), ["/skill example "]);
  assert.equal(slashChoices("/skill ex", [{ name: "example", description: "A skill" }], () => false), null);
});

test("Desktop menu consumes completion keys but preserves composition and multiline input", () => {
  let chosen = -1, position = -1, dismissed = 0, prevented = 0;
  const event = (key: string, overrides = {}) => ({ key, shiftKey: false, repeat: false, nativeEvent: {}, preventDefault() { ++prevented; }, ...overrides });
  const key = (value: ReturnType<typeof event>, count = 2, index = 0) => slashMenuKey(value, count, index, at => { chosen = at; }, at => { position = at; }, () => { ++dismissed; });
  for (const value of [event("Enter", { shiftKey: true }), event("Enter", { nativeEvent: { isComposing: true } }), event("Enter", { nativeEvent: { keyCode: 229 } }), event("Enter", { repeat: true })]) assert.equal(key(value), false);
  assert.equal(prevented, 0);
  assert.equal(key(event("ArrowUp")), true); assert.equal(position, 1);
  assert.equal(key(event("ArrowDown"), 2, 1), true); assert.equal(position, 0);
  for (const value of ["Enter", "Tab"]) { chosen = -1; assert.equal(key(event(value), 2, 1), true); assert.equal(chosen, 1); }
  assert.equal(key(event("Escape"), 0), true); assert.equal(dismissed, 1);
  assert.equal(key(event("Enter"), 0), false);
});

test("Desktop named current-history branching uses the existing operation without a model task", async () => {
  const snapshot = fakeSnapshot();
  const source: Session = { id: "source", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 1, defaultAccessMode: "confirm", defaultAccessModeVersion: 1, queueState: "active", queuePauseReason: null, queueRevision: 0, archivedAt: null, createdAt: "2026-11-08T00:00:00Z" };
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const model = new CodeState({ request: async (_target, op, params) => {
    calls.push({ op, params });
    if (op === "branch_session") return { ok: true, value: { ...source, id: "branch", name: params.name, createRequestId: params.request_id } };
    return { ok: false, error: { code: "unconfigured_read", outcome: "rejected", message: `Unexpected background read: ${op}` } };
  } }, () => {});
  model.view.applySnapshot({ snapshot: { ...snapshot, sessions: [source] }, replay: [], seq: 0 }, false);
  model.status = { type: "state", state: "online" };
  assert.equal(await model.branch(source.id, undefined, "Named branch"), true);
  const branches = calls.filter(call => call.op === "branch_session");
  assert.equal(branches.length, 1);
  assert.equal(branches[0].params.name, "Named branch");
  assert.equal(branches[0].params.task_id, undefined);
  assert.equal(model.view.currentSessionId, "branch");
  assert.equal(calls.some(call => call.op === "submit"), false);
});
