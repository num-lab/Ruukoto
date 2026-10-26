/** QQ 私聊复用 main：原始群项目与带来源的派生资料隔离，既有共享副本保留。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { AccessScope } from "@ruukoto/core/access.ts";
import { HistoryIndex } from "@ruukoto/core/history-index.ts";
import { MemoryStore } from "@ruukoto/core/memory.ts";
import { DATA_CATEGORIES, type Session, type NotifyTarget, type MemorySourceRef } from "@ruukoto/core/types.ts";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import { createHostDataTools } from "@ruukoto/agent/host-tools.ts";
import { createSourceResolver } from "@ruukoto/channels/source-resolver.ts";
import { SchedulerStore, sha256 } from "@ruukoto/channels/scheduler/store.ts";
import { cleanupDirs, makeTestDirs } from "./helpers/testkit.ts";

test("QQ 私聊资料边界：授权不能放开 main/coding 的群资料，来源检查覆盖工具与旧快照", async () => {
  const { dirs, work } = await makeTestDirs("qq-private-scope", 4);
  const db = new Db(dirs.dataDir);
  try {
    const store = new Store(db);
    const access = new AccessScope(db);
    const memories = new MemoryStore(db);
    const historyIndex = new HistoryIndex(db);
    const artifacts = new ArtifactStore(dirs.dataDir, store);
    const sessions = {} as Record<"main" | "coding" | "group" | "dev", Session>;
    const modelSelection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" as const };
    const texts = { main: "SHARED-COPY 已有共享副本", coding: "CODING-HISTORY", group: "QQ-GROUP-SECRET", dev: "DEV-REFERENCE" };
    for (const [i, name] of (["main", "coding", "group", "dev"] as const).entries()) {
      // 群项目故意不用 qq 名称，普通开发项目故意使用 qq 名称。
      const project = store.createProject(name === "dev" ? "qq-123-456" : name);
      const stat = fs.statSync(work[i]);
      const sessionFile = path.join(dirs.root, `${name}.jsonl`);
      fs.writeFileSync(sessionFile, JSON.stringify({
        type: "message", id: "entry", parentId: null, timestamp: "2026-09-24T00:00:00Z",
        message: { role: "user", content: [{ type: "text", text: texts[name] }] },
      }) + "\n");
      const session = store.createSession({
        projectId: project.id, kind: name === "group" ? "qq_group" : "dev", cwd: work[i],
        cwdReal: fs.realpathSync(work[i]), cwdDev: stat.dev, cwdIno: stat.ino,
        piSessionId: name, sessionFile, confirmTools: [], modelSelection,
      });
      sessions[name] = session;
      if (name === "main" || name === "coding") {
        store.insertAgentRole({ id: name, projectId: project.id, sessionId: session.id, workDir: work[i], modelSelection, tools: [], createdAt: session.createdAt });
      }
    }
    for (const category of DATA_CATEGORIES) {
      for (const name of ["main", "coding", "dev"] as const) {
        access.createGrant({ fromProjectId: sessions.group.projectId, toProjectId: sessions[name].projectId, category });
      }
      for (const name of ["main", "coding"] as const) {
        access.createGrant({ fromProjectId: sessions.dev.projectId, toProjectId: sessions[name].projectId, category });
      }
      for (const name of ["main", "coding"] as const) {
        const accessor = { kind: "agent" as const, projectId: sessions[name].projectId };
        assert.equal(access.canAccess(accessor, sessions.group.projectId, category), false, `${name} 的显式群授权不能放宽边界`);
        assert.equal(access.accessibleProjects(accessor, category).includes(sessions.group.projectId), false);
        assert.equal(access.canAccess(accessor, sessions.dev.projectId, category), true, "普通开发资料授权有效");
      }
      assert.equal(access.canAccess({ kind: "owner" }, sessions.group.projectId, category), true, "owner 控制面保留完整读取范围");
      assert.equal(access.canAccess({ kind: "agent", projectId: sessions.dev.projectId }, sessions.group.projectId, category), true, "普通 dev 的群授权不受角色限制");
    }

    const taskFor = (name: keyof typeof sessions, parentTaskId?: string) => {
      const task = store.insertQueuedTask({ sessionId: sessions[name].id, requestId: name, input: name, modelSelection, submissionDigest: name, parentTaskId }).task;
      store.transitionTask(task.id, ["queued"], "completed", { endedAt: "2026-09-24T00:00:00Z" });
      store.setTaskResult(task.id, texts[name], "{}");
      return store.getTask(task.id)!;
    };
    const mainTask = taskFor("main");
    const groupTask = taskFor("group", mainTask.id); // 即使有父子关系，也不能读取原始群结果。
    const codingTask = taskFor("coding", mainTask.id);
    const groupArtifact = artifacts.begin({ taskId: groupTask.id, sessionId: groupTask.sessionId, name: "群资料" });
    artifacts.append(groupArtifact.id, Buffer.from(texts.group));
    artifacts.complete(groupArtifact.id);
    const groupHistory: MemorySourceRef = { kind: "history_entry", sessionId: sessions.group.id, entryId: "entry" };
    const groupArtifactRef: MemorySourceRef = { kind: "artifact", artifactId: groupArtifact.id };
    const ownerNote: MemorySourceRef = { kind: "owner_note", note: "可信入口明确记录" };
    assert.equal(access.sourceRefAccessible({ kind: "agent", projectId: sessions.main.projectId }, groupHistory), false);
    assert.equal(access.sourceRefAccessible({ kind: "agent", projectId: sessions.main.projectId }, groupArtifactRef), false);
    assert.equal(access.sourceRefAccessible({ kind: "owner" }, groupHistory), true);

    let activeSession = sessions.main;
    const taskContext = () => ({ taskId: mainTask.id, sessionId: activeSession.id, projectId: activeSession.projectId, hostOpId: "scope-test" });
    const dataTools = createHostDataTools({
      store, access, historyIndex, memories, taskContext,
      sessionFileFor: (id) => store.getSession(id)?.sessionFile ?? null,
      projectOfSession: (id) => store.getSession(id)?.projectId ?? null,
      syncSession: (id) => {
        const file = store.getSession(id)!.sessionFile!;
        historyIndex.sync(id, file);
        return { unindexed: !historyIndex.isIndexed(id) };
      },
    });
    const call = async (tools: ToolDefinition[], name: string, params: Record<string, unknown>) => {
      const result = await tools.find((tool) => tool.name === name)!.execute("scope-test", params, undefined, undefined, {} as ExtensionToolContext);
      return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
    };
    for (const session of [sessions.main, sessions.coding]) {
      activeSession = session;
      assert.doesNotMatch(await call(dataTools, "history_search", { query: texts.group }), /QQ-GROUP-SECRET/);
      await assert.rejects(call(dataTools, "history_read", { session_id: sessions.group.id, entry_id: "entry" }), /无权读取/);
      assert.match(await call(dataTools, "history_search", { query: texts.dev }), /DEV-REFERENCE/);
    }
    activeSession = sessions.main;
    assert.match(await call(dataTools, "history_read", { session_id: sessions.main.id, entry_id: "entry" }), /SHARED-COPY/, "不会追溯删除已有 main 共享副本");

    const privateDerived = memories.create({ projectId: sessions.main.projectId, category: "decision", content: texts.group, sourceRefs: [groupHistory], author: "owner" });
    const personalDerived = memories.create({ projectId: null, category: "decision", content: texts.group, sourceRefs: [groupArtifactRef], author: "owner" });
    const groupMemory = memories.create({ projectId: sessions.group.projectId, category: "decision", content: texts.group, sourceRefs: [ownerNote], author: "owner" });
    const revised = memories.create({ projectId: sessions.main.projectId, category: "decision", content: texts.group, sourceRefs: [groupArtifactRef], author: "owner" });
    memories.revise({ memoryId: revised.id, expectedVersion: 1, content: "SAFE-REVISION", sourceRefs: [ownerNote], author: "owner" });
    memories.create({ projectId: null, category: "preference", content: "SAFE-PERSONAL", sourceRefs: [ownerNote], author: "owner" });
    const listed = await call(dataTools, "memory_list", {});
    assert.doesNotMatch(listed, /QQ-GROUP-SECRET/);
    assert.match(listed, /SAFE-REVISION/);
    assert.match(listed, /SAFE-PERSONAL/);
    for (const memory of [privateDerived, personalDerived, groupMemory]) {
      await assert.rejects(call(dataTools, "memory_read", { memory_id: memory.id }), /无权读取|来源范围/);
    }
    await assert.rejects(call(dataTools, "memory_read", { memory_id: revised.id, version: 1 }), /来源范围/);
    assert.match(await call(dataTools, "memory_read", { memory_id: revised.id }), /SAFE-REVISION/);
    assert.equal(memories.getVersion(revised.id, 1)!.content, texts.group, "owner 管理存储中的原文与旧版本保留");

    // 通知与 coding materials 共用这个解析器；群资料不能经任务结果、产物或父子关系传入。
    const sources = createSourceResolver({ store, access, artifacts, appData: () => null });
    assert.throws(() => sources.resolve(sessions.main.projectId, [{ kind: "task_result", task_id: groupTask.id }]), /不在当前步骤可读范围/);
    assert.throws(() => sources.resolve(sessions.main.projectId, [{ kind: "artifact", artifact_id: groupArtifact.id }]), /不在当前步骤可读范围/);
    assert.equal(sources.resolve(sessions.main.projectId, [{ kind: "task_result", task_id: codingTask.id }]).text, texts.coding, "正常 coding 子任务结果仍可读");
    const oldSnapshot = sources.resolve(sessions.dev.projectId, [{ kind: "artifact", artifact_id: groupArtifact.id }]);
    assert.match(sources.verify(sessions.main.projectId, oldSnapshot.refs)!, /授权已撤销|不可读/);
    assert.match(sources.verify(sessions.main.projectId, [{ kind: "task_result", ref: `task:${groupTask.id}`, version: groupTask.endedAt!, sha256: sha256(texts.group) }])!, /授权已撤销|不可读/);

    // 旧账本保留原正文，读取资格由上面的来源核实决定。
    const sched = new SchedulerStore(store);
    const target: NotifyTarget = { channel: "mock", account: "bot", chatId: "owner", configVersion: 1 };
    const oldOp = sched.insertOp({ sourceKind: "confirmation", sourceKey: "old-group", taskId: null, hostOpId: null, target, text: oldSnapshot.text, sourceRefs: oldSnapshot.refs }).op;
    const oldSchedule = sched.insertSchedule({
      createKey: "old-group", paramsDigest: "old-group", createTaskId: null, createOpId: null,
      projectId: sessions.main.projectId, createPermissionVersion: 1, accessMode: "confirm", rule: { kind: "once", at: "2026-10-01T00:00:00.000Z", timeZone: "UTC", disambiguation: "compatible" },
      instruction: oldSnapshot.text, sourceRefs: oldSnapshot.refs, target,
      nextDueAt: "2026-10-01T00:00:00.000Z", tzData: "test", reason: "旧计划",
    }, "test");
    assert.equal(sched.getOp(oldOp.id)!.text, texts.group, "owner 控制面仍能取得旧账本正文");
    assert.equal(sched.getSchedule(oldSchedule.id)!.instruction, texts.group);
  } finally {
    db.close();
    await cleanupDirs(dirs);
  }
});
