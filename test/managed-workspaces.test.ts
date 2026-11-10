import { profileChildEnv } from "@ruukoto/core/profile.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import childProcess, { spawn, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";

import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { getManagedWorkspaceRequest, managedWorkspaceRequestKey } from "@ruukoto/core/managed-workspaces.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { startTestRuntime, realTools, afterTool, lastUserText, waitFor } from "./helpers/testkit.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { ViewState } from "@ruukoto/view/state.ts";

const selection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" as const };
const config = {  };
const fails = (code: string) => (error: unknown): boolean => (error instanceof RuntimeApiError || error instanceof ControlClientError) && error.code === code;

test("managed creation binds independent roots, defaults and events only when requested; selected workspaces stay compatible", async () => {
  const t = await startTestRuntime("managed-creation", () => ({ kind: "text", text: "ok" }), { config });
  try {
    const parent = t.dirs.profile.workspaceDir;
    const before = t.runtime.store.listSessions().length;
    await assert.rejects(t.client.request("create_managed_session", { request_id: "bad", cwd: t.work[0] }), fails("invalid_params"));
    assert.equal(t.runtime.store.listSessions().length, before);
    const a = await t.client.request<OpResult<"create_managed_session">>("create_managed_session", { request_id: "managed-a", mode: "full_access", model_selection: selection });
    const b = await t.client.request<OpResult<"create_managed_session">>("create_managed_session", { request_id: "managed-b" });
    assert.notEqual(a.project.id, b.project.id);
    assert.notEqual(a.session.cwdReal, b.session.cwdReal);
    for (const created of [a, b]) {
      assert.equal(created.project.managed, true);
      assert.equal(created.project.rootDir!.cwdReal, path.join(parent, created.project.id));
      assert.equal(created.session.cwdReal, created.project.rootDir!.cwdReal);
      assert.deepEqual(created.project.instructionFiles, []);
      assert.equal(created.session.projectId, created.project.id);
      assert.equal(created.session.sessionFile, null);
    }
    assert.equal(a.session.defaultAccessMode, "full_access");
    assert.equal(b.session.defaultAccessMode, "confirm");
    assert.deepEqual(b.session.modelSelection, selection);
    const state = new ViewState();
    for (const event of t.runtime.store.getEventsAfter(0)) state.applyEvent(event, "live");
    assert.equal(state.projects.find(project => project.id === a.project.id)?.managed, true);
    assert.equal((await t.client.handshake()).snapshot.projects.find(project => project.id === b.project.id)?.managed, true);
    const again = await t.client.request<OpResult<"create_managed_session">>("create_managed_session", { request_id: "managed-a", mode: "full_access", model_selection: selection });
    assert.equal(again.session.id, a.session.id);
    assert.equal((await t.client.request<OpResult<"find_created_session">>("find_created_session", { request_id: "managed-a" }))!.id, a.session.id);
    assert.equal(await t.client.request("find_created_session", { request_id: "not-created" }), null);
    await assert.rejects(t.client.request("create_managed_session", { request_id: "managed-a", mode: "confirm", model_selection: selection }), fails("request_conflict"));
    const ordinary = await t.runtime.openWorkspace({ cwd: t.work[0], createRequestId: "selected" });
    assert.equal(t.runtime.store.getProject(ordinary.session.projectId)!.managed, undefined);
    await assert.rejects(t.runtime.createManagedSession({ createRequestId: "selected" }), fails("request_conflict"));
    await assert.rejects(t.runtime.openWorkspace({ cwd: a.session.cwd, createRequestId: "managed-a" }), fails("request_conflict"));
    await assert.rejects(t.runtime.createSession({ projectId: a.project.id, cwd: a.session.cwd, createRequestId: "managed-a" }), fails("request_conflict"));
    assert.throws(() => t.runtime.createProject("different", "managed-a"), fails("request_conflict"));
    await assert.rejects(t.runtime.branchSession({ sessionId: a.session.id, requestId: "managed-a" }), fails("request_conflict"));
    await assert.rejects(t.runtime.openSideChat({ sessionId: a.session.id, requestId: "managed-a" }), fails("request_conflict"));
    const current = await t.runtime.setSessionDefaultMode({ sessionId: a.session.id, mode: "plan", expectedVersion: 0 });
    assert.equal((await t.runtime.createManagedSession({ createRequestId: "managed-a", mode: "full_access", modelSelection: selection })).session.defaultAccessMode, current.defaultAccessMode);
    assert.equal(t.runtime.store.listSessions().length, before + 3);
    assert.equal(fs.readdirSync(parent).filter(name => name.startsWith("proj_")).length, 2);
  } finally { await t.shutdown(); }
});

test("managed workspaces keep file roots, scoped history/artifacts, branch files and archive/restart retention", async () => {
  let foreignArtifact = "";
  const t = await startTestRuntime("managed-scope", req => {
    if (afterTool(req)) return { kind: "text", text: "done" };
    const text = lastUserText(req);
    if (text === "write-alpha" || text === "write-beta" || text === "branch-write") return { kind: "tool_calls", calls: [{ id: "write", name: "write", arguments: { path: "work.txt", content: text } }] };
    if (text === "inspect-history") return { kind: "tool_calls", calls: [{ id: "search", name: "history_search", arguments: { query: "PRIVATE-BETA-SECRET", role: "user" } }] };
    if (text === "inspect-artifact") return { kind: "tool_calls", calls: [{ id: "read", name: "read_artifact", arguments: { artifact_id: foreignArtifact } }] };
    return { kind: "text", text: "ok" };
  }, { config: { ...config, ...realTools() } });
  let reopened: Runtime | null = null;
  try {
    const a = await t.runtime.createManagedSession({ createRequestId: "scope-a", mode: "full_access" });
    const b = await t.runtime.createManagedSession({ createRequestId: "scope-b", mode: "full_access" });
    const submit = async (sessionId: string, input: string, requestId: string) => {
      const task = await t.runtime.submit({ sessionId, input, requestId, modelSelection: selection });
      await waitFor("managed task completed", () => t.runtime.store.getTask(task.id)!.status === "completed");
      return t.runtime.store.getTask(task.id)!;
    };
    await submit(a.session.id, "write-alpha", "write-a");
    await submit(b.session.id, "write-beta", "write-b");
    assert.equal(fs.readFileSync(path.join(a.session.cwd, "work.txt"), "utf8"), "write-alpha");
    assert.equal(fs.readFileSync(path.join(b.session.cwd, "work.txt"), "utf8"), "write-beta");
    const seed = await submit(b.session.id, "PRIVATE-BETA-SECRET", "beta-seed");
    const artifact = t.runtime.artifacts.begin({ taskId: seed.id, sessionId: b.session.id, name: "beta.txt" });
    t.runtime.artifacts.append(artifact.id, Buffer.from("PRIVATE-BETA-ARTIFACT"));
    t.runtime.artifacts.complete(artifact.id);
    foreignArtifact = artifact.id;
    const historyDenied = await submit(a.session.id, "inspect-history", "history-denied");
    assert.match(t.runtime.store.listToolOpsByTask(historyDenied.id).find(op => op.toolName === "history_search")!.resultSummary!, /命中 0 条/);
    const artifactDenied = await submit(a.session.id, "inspect-artifact", "artifact-denied");
    assert.equal(t.runtime.store.listToolOpsByTask(artifactDenied.id).find(op => op.toolName === "read_artifact")!.isError, true);
    const grants = t.runtime.store.withTx(() => ["history", "artifact"].map(category => t.runtime.access.createGrant({ fromProjectId: b.project.id, toProjectId: a.project.id, category: category as "history" | "artifact" })));
    const historyAllowed = await submit(a.session.id, "inspect-history", "history-allowed");
    assert.match(t.runtime.store.listToolOpsByTask(historyAllowed.id).find(op => op.toolName === "history_search")!.resultSummary!, /PRIVATE-BETA-SECRET/);
    const artifactAllowed = await submit(a.session.id, "inspect-artifact", "artifact-allowed");
    assert.equal(t.runtime.store.listToolOpsByTask(artifactAllowed.id).find(op => op.toolName === "read_artifact")!.isError, false);
    t.runtime.store.withTx(() => grants.forEach(grant => t.runtime.access.revokeGrant(grant.id)));
    assert.equal(t.runtime.access.canAccess({ kind: "agent", projectId: a.project.id }, b.project.id, "artifact"), false);
    const branch = await t.runtime.branchSession({ sessionId: a.session.id, requestId: "managed-branch" });
    assert.equal(branch.projectId, a.project.id);
    assert.equal(branch.cwd, a.session.cwd);
    assert.equal(branch.cwdIno, a.session.cwdIno);
    assert.equal(t.runtime.store.listProjects().filter(project => project.managed).length, 2);
    assert.equal(fs.readdirSync(path.dirname(a.session.cwd)).filter(name => name.startsWith("proj_")).length, 2);
    await submit(branch.id, "branch-write", "branch-follow-up");
    assert.equal(fs.readFileSync(path.join(a.session.cwd, "work.txt"), "utf8"), "branch-write");
    const sourceHistory = await t.runtime.readHistory({ sessionId: a.session.id });
    const branchHistory = await t.runtime.readHistory({ sessionId: branch.id });
    assert.equal(JSON.stringify(sourceHistory.entries).includes("branch-write"), false);
    assert.equal(JSON.stringify(branchHistory.entries).includes("branch-write"), true);
    const files = await t.runtime.listWorkspaceFiles({ workspaceId: a.project.id });
    assert.ok(files.entries.some(entry => entry.name === "work.txt"));
    assert.equal(Buffer.from(t.runtime.readWorkspaceFile({ workspaceId: a.project.id, path: "work.txt" }).data, "base64").toString(), "branch-write");
    assert.equal((await t.runtime.readWorkspaceGit({ workspaceId: a.project.id })).repository, null);
    await t.runtime.setSessionArchived({ sessionId: a.session.id, archived: true });
    assert.equal(t.runtime.store.getSession(branch.id)!.archivedAt, null);
    const storedHistory = fs.readFileSync(t.runtime.store.getSession(a.session.id)!.sessionFile!);
    await t.runtime.stop("managed-restart");
    reopened = await Runtime.start(t.runtime.config);
    assert.equal(reopened.findManagedSession("scope-a").session!.id, a.session.id);
    assert.equal(fs.readFileSync(path.join(a.session.cwd, "work.txt"), "utf8"), "branch-write");
    assert.deepEqual(fs.readFileSync(reopened.store.getSession(a.session.id)!.sessionFile!), storedHistory);
    assert.ok(reopened.store.getSession(a.session.id)!.archivedAt);
    assert.equal(reopened.store.getSession(branch.id)!.archivedAt, null);
  } finally { await reopened?.stop("test-end"); await t.shutdown(); }
});

test("managed creation preserves the committed receipt when post-commit delivery fails", async () => {
  const t = await startTestRuntime("managed-commit", () => ({ kind: "text", text: "ok" }), { config });
  try {
    const delivery = t.runtime.store.onCommitted;
    t.runtime.store.onCommitted = events => {
      if (events.some(event => event.body.type === "project.created" && event.body.managed)) throw new Error("lost response after commit");
      delivery?.(events);
    };
    const created = await t.runtime.createManagedSession({ createRequestId: "commit-lost" });
    t.runtime.store.onCommitted = delivery;
    const found = t.runtime.findManagedSession("commit-lost");
    assert.equal(found.status, "published");
    assert.equal(found.session!.id, created.session.id);
    assert.equal((await t.runtime.createManagedSession({ createRequestId: "commit-lost" })).session.id, created.session.id);
    assert.equal(t.runtime.store.listProjects().filter(project => project.managed).length, 1);
  } finally { await t.shutdown(); }
});

test("managed preparation retains implicit defaults and ignores unrelated corrupt receipts on restart", async () => {
  const t = await startTestRuntime("managed-default-recovery", () => ({ kind: "text", text: "ok" }), { config });
  let reopened: Runtime | null = null;
  try {
    const create = t.runtime.store.createSession.bind(t.runtime.store);
    t.runtime.store.createSession = input => {
      if (input.managedWorkspace) throw new Error("before session publication");
      return create(input);
    };
    await assert.rejects(t.runtime.createManagedSession({ createRequestId: "frozen-default" }), fails("managed_prepare_failed"));
    t.runtime.store.createSession = create;
    const receipt = getManagedWorkspaceRequest(t.runtime.store, "frozen-default")!;
    assert.deepEqual(receipt.modelSelection, selection);
    assert.equal(receipt.mode, "confirm");
    const corrupt = JSON.stringify({ requestId: "bad-record" });
    t.runtime.store.setMetaValue(managedWorkspaceRequestKey("bad-record"), corrupt);
    const modelsFile = path.join(t.dirs.agentDir, "models.json");
    const models = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
    models.providers.mock.models.push({ ...models.providers.mock.models[0], id: "reasoner", reasoning: true });
    fs.writeFileSync(modelsFile, JSON.stringify(models));
    const changedConfig = { ...t.runtime.config, modelId: "reasoner", thinkingLevel: "high" as const };
    await t.runtime.stop("defaults-restart");
    reopened = await Runtime.start(changedConfig);
    assert.equal(reopened.defaultSelection.modelId, "reasoner");
    assert.equal(reopened.defaultSelection.thinkingLevel, "high");
    const result = reopened.findManagedSession("frozen-default");
    assert.equal(result.status, "published");
    assert.deepEqual(result.session!.modelSelection, selection);
    assert.equal(result.session!.defaultAccessMode, "confirm");
    assert.equal((await reopened.createManagedSession({ createRequestId: "frozen-default" })).session.id, result.session!.id);
    assert.equal(reopened.store.getMetaValue(managedWorkspaceRequestKey("bad-record")), corrupt);
    assert.equal(reopened.store.listProjects().filter(project => project.managed).length, 1);
  } finally { await reopened?.stop("test-end"); await t.shutdown(); }
});

test("production and development profiles allocate separate managed roots without copying source configuration", async () => {
  const a = await startTestRuntime("managed-production", () => ({ kind: "text", text: "ok" }), { config });
  const b = await startTestRuntime("managed-development", () => ({ kind: "text", text: "ok" }), { config });
  try {
    const source = await a.runtime.openWorkspace({ cwd: a.work[0] });
    fs.writeFileSync(path.join(source.session.cwd, "AGENTS.md"), "Source-only project instructions\n");
    a.runtime.store.withTx(() => a.runtime.store.updateProjectSettings({ projectId: source.session.projectId, instructionFiles: ["AGENTS.md"] }));
    const grantSource = await a.runtime.openWorkspace({ cwd: a.work[1] });
    a.runtime.store.withTx(() => a.runtime.access.createGrant({ fromProjectId: grantSource.session.projectId, toProjectId: source.session.projectId, category: "history" }));
    a.runtime.credentials.upsert({ name: "source-credential", host: "example.invalid", header: "authorization", purpose: "other", secret: "offline-test-value", scope: { projectId: source.session.projectId, operations: ["other"] } });
    const first = await a.runtime.createManagedSession({ createRequestId: "same-key" });
    const second = await b.runtime.createManagedSession({ createRequestId: "same-key" });
    assert.notEqual(first.project.id, second.project.id);
    assert.equal(first.session.cwdReal, path.join(a.dirs.profile.workspaceDir, first.project.id));
    assert.equal(second.session.cwdReal, path.join(b.dirs.profile.workspaceDir, second.project.id));
    assert.deepEqual(first.project.instructionFiles, []);
    assert.equal(fs.existsSync(path.join(first.session.cwd, "AGENTS.md")), false);
    assert.equal(a.runtime.access.listGrants().some(grant => grant.toProjectId === first.project.id || grant.fromProjectId === first.project.id), false);
    assert.equal(a.runtime.credentials.getForUse("source-credential", { projectId: first.project.id, operation: "other" }), null);
    assert.ok(a.runtime.credentials.getForUse("source-credential", { projectId: source.session.projectId, operation: "other" }));
    assert.equal(a.runtime.credentials.list().length, 1);
    assert.deepEqual(a.runtime.store.getProject(source.session.projectId)!.instructionFiles, ["AGENTS.md"]);
  } finally { await a.shutdown(); await b.shutdown(); }
});

test("managed receipts reject corrupt authority and replaced directories without changing the original data", async () => {
  const t = await startTestRuntime("managed-corruption", () => ({ kind: "text", text: "ok" }), { config });
  try {
    const created = await t.runtime.createManagedSession({ createRequestId: "original" });
    const request = getManagedWorkspaceRequest(t.runtime.store, "original")!;
    const escaped = path.join(fs.realpathSync(t.dirs.root), "foreign-parent", request.projectId);
    for (const value of [{ ...request, requestId: "corrupt", root: escaped, parent: null, stage: null, sessionId: null }, { requestId: "corrupt" }, { ...request, requestId: "different" }]) {
      const text = JSON.stringify(value);
      t.runtime.store.setMetaValue(managedWorkspaceRequestKey("corrupt"), text);
      await assert.rejects(t.runtime.createManagedSession({ createRequestId: "corrupt" }), fails("managed_workspace_corrupt"));
      assert.equal(t.runtime.store.getMetaValue(managedWorkspaceRequestKey("corrupt")), text);
      assert.equal(fs.existsSync(escaped), false);
    }
    t.runtime.store.db.prepare("DELETE FROM meta WHERE key = ?").run(managedWorkspaceRequestKey("corrupt"));
    t.runtime.store.db.prepare("UPDATE projects SET root_dev = root_dev + 1 WHERE id = ?").run(created.project.id);
    assert.equal(t.runtime.findManagedSession("original").session!.id, created.session.id, "device-only remount change retains existing directory checks");
    fs.writeFileSync(path.join(created.session.cwd, "saved.txt"), "retained");
    fs.renameSync(created.session.cwd, `${created.session.cwd}-original`);
    fs.symlinkSync(`${created.session.cwd}-original`, created.session.cwd);
    await assert.rejects(t.runtime.createManagedSession({ createRequestId: "original" }), fails("cwd_changed"));
    assert.equal(fs.readFileSync(path.join(`${created.session.cwd}-original`, "saved.txt"), "utf8"), "retained");
    fs.unlinkSync(created.session.cwd);
    fs.mkdirSync(created.session.cwd);
    await assert.rejects(t.runtime.createManagedSession({ createRequestId: "original" }), fails("cwd_changed"));
    assert.equal(t.runtime.store.listProjects().filter(project => project.managed).length, 1);
  } finally { await t.shutdown(); }
});

for (const phase of ["reserved", "stage-unrecorded", "staged", "installed"] as const) test(`managed real SIGKILL at ${phase} recovers the original workspace once`, async () => {
  const t = await startTestRuntime(`managed-kill-${phase}`, () => ({ kind: "text", text: "ok" }), { config });
  let reopened: Runtime | null = null;
  try {
    await t.runtime.stop("before-child");
    const script = `
      import * as fs from 'node:fs';
      import { Runtime } from './packages/runtime/src/runtime.ts';
      import { readProfile, selectProfile } from '@ruukoto/core/profile.ts';
      const profile = readProfile(selectProfile());
      if (!profile) throw new Error('Crash fixture profile is not active');
      const runtime = await Runtime.start({ profile, modelProvider: 'mock', modelId: 'mock-model' });
      const phase=process.argv[1];
      const save=runtime.store.setMetaValue.bind(runtime.store);
      runtime.store.setMetaValue=(key,value)=>{
        if(key.startsWith('managed_workspace_request:')){
          const r=JSON.parse(value);
          if(phase==='stage-unrecorded' && r.stage) process.kill(process.pid,'SIGKILL');
        }
        save(key,value);
      };
      const tx=runtime.store.withTx.bind(runtime.store);
      runtime.store.withTx=action=>{
        const result=tx(action);
        const raw=runtime.store.getMetaValue('managed_workspace_request:killed');
        if(raw){ const r=JSON.parse(raw); if((phase==='reserved' && !r.parent)||(phase==='staged' && r.stage&&!r.sessionId)) process.kill(process.pid,'SIGKILL'); }
        return result;
      };
      const create=runtime.store.createSession.bind(runtime.store);
      runtime.store.createSession=input=>{ if(phase==='installed' && input.managedWorkspace) process.kill(process.pid,'SIGKILL'); return create(input); };
      await runtime.createManagedSession({createRequestId:'killed'});
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, phase], { stdio: ["ignore", "ignore", "pipe"], env: profileChildEnv(t.dirs.profile.selection) });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("managed creation crash fixture timed out")); }, 15_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (_code, signal) => { clearTimeout(timer); resolve(signal); });
    });
    assert.equal(signal, "SIGKILL", stderr);
    reopened = await Runtime.start(t.runtime.config);
    const found = reopened.findManagedSession("killed");
    assert.equal(found.status, "published");
    assert.equal((await reopened.createManagedSession({ createRequestId: "killed" })).session.id, found.session!.id);
    assert.equal(reopened.store.listProjects().filter(project => project.managed).length, 1);
    assert.equal(fs.readdirSync(path.dirname(found.session!.cwd)).filter(name => name.startsWith("proj_")).length, 1);
    assert.equal(t.server.calls.length, 0);
  } finally { await reopened?.stop("test-end"); await t.shutdown(); }
});

test("exclusive installation refuses a raced foreign target and retains its prepared identity for retry", async context => {
  const t = await startTestRuntime("managed-race", () => ({ kind: "text", text: "ok" }), { config });
  try {
    const execute = execFileSync;
    let foreignRoot = "";
    // Refresh the named import after installing the real-syscall race fixture.
    context.mock.method(childProcess, "execFileSync", (file: string, args: readonly string[], options: object) => {
      if (args[1] === "install") {
        const request = getManagedWorkspaceRequest(t.runtime.store, "raced")!;
        foreignRoot = request.root;
        fs.mkdirSync(foreignRoot);
      }
      return execute(file, args, options);
    });
    syncBuiltinESMExports();
    await assert.rejects(t.runtime.createManagedSession({ createRequestId: "raced" }), fails("managed_prepare_failed"));
    const foreignIno = fs.statSync(foreignRoot).ino;
    const receipt = getManagedWorkspaceRequest(t.runtime.store, "raced")!;
    assert.ok(receipt.stage);
    assert.equal(receipt.sessionId, null);
    assert.equal(fs.statSync(foreignRoot).ino, foreignIno);
    assert.equal(t.runtime.store.listProjects().filter(project => project.managed).length, 0);
    context.mock.restoreAll(); syncBuiltinESMExports();
    fs.renameSync(foreignRoot, `${foreignRoot}-foreign`);
    const retried = await t.runtime.createManagedSession({ createRequestId: "raced" });
    assert.equal(retried.project.id, receipt.projectId);
    assert.equal(retried.session.cwdIno, receipt.stage!.ino);
    assert.equal(fs.statSync(`${foreignRoot}-foreign`).ino, foreignIno);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await t.shutdown(); }
});
