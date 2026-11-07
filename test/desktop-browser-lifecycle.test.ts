import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { Driver } from "@ruukoto/agent/driver.ts";
import { DesktopBrowserManager } from "@ruukoto/agent/desktop-browser.ts";
import { createDesktopBrowserFamily } from "@ruukoto/agent/desktop-browser-tools.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { HistoryIndex } from "@ruukoto/core/history-index.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import { startAssemblyKit, waitFor } from "./helpers/testkit.ts";

for (const ending of ["complete", "return", "cancel", "lost-open"] as const) {
  test(`Desktop browser task ${ending} releases its page through the real Driver lifecycle`, async () => {
    const kit = await startAssemblyKit("desktop-browser-lifecycle", { responder: (_request, index) => index === 0
      ? { kind: "tool_calls", calls: [{ id: "open-page", name: "desktop_browser", arguments: { action: "open", url: "https://example.test" } }] }
      : { kind: "text", text: "Done" } });
    const { session } = kit.project();
    const task = kit.store.withTx(() => {
      const task = kit.store.insertQueuedTask({ sessionId: session.id, requestId: "use-browser", input: "Inspect the page", accessMode: "full_access", modelSelection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, submissionDigest: "browser" }).task;
      kit.store.bindTaskBrowser(task.id, "desktop"); kit.store.transitionTask(task.id, ["queued"], "running");
      return kit.store.getTask(task.id)!;
    });
    const calls: string[] = [];
    let generation = 0, waits = 0;
    const manager = new DesktopBrowserManager({ store: kit.store, call: () => async (_connection, params) => {
      const op = String(params.op); calls.push(op); assert.equal(params.task, task.id);
      if (op === "open") {
        manager.onEvent("desktop", { session: session.id, kind: "gate", source: "host", owned: true, generation: ++generation });
        if (ending === "return" || ending === "cancel") manager.onEvent("desktop", { session: session.id, kind: "gate", source: "owner", owned: false, generation: ++generation });
        if (ending === "lost-open") throw new Error("Open response lost");
      }
      if (op === "release") manager.onEvent("desktop", { session: session.id, kind: "gate", source: "host", owned: false, generation: ++generation });
      return { ok: true, value: op === "eval" ? { generation, value: JSON.stringify({ url: "https://example.test", title: "Page", text: "Owner updated page" }) } : { exists: true, generation, owned: op !== "release", ownerHeld: false, gone: false } };
    } });
    const awaitGate = manager.awaitGate.bind(manager);
    manager.awaitGate = (...args) => { waits++; return awaitGate(...args); };
    const driver = new Driver(session, { ...kit.deps, ledger: new ToolOpLedger(kit.store), historyIndex: new HistoryIndex(kit.store.db),
      sessionsDir: path.join(kit.dirs.dataDir, "sessions"), model: kit.model, thinkingLevel: "off", toolFactory: () => [],
      launcherFor: () => { throw new Error("This test uses no worker tools"); }, protectedRoots: [kit.dirs.dataDir], onOccupancyReleased: () => {},
      desktopBrowser: manager, hostToolFamilies: [createDesktopBrowserFamily({ store: kit.store, artifacts: kit.deps.artifacts, manager })],
    });
    try {
      const running = driver.run(task);
      if (ending === "return" || ending === "cancel") {
        await waitFor("Agent waits for the taken-over page", () => waits > 0);
        assert.equal(kit.server.calls.length, 1);
        if (ending === "return") manager.onEvent("desktop", { session: session.id, kind: "gate", source: "owner", owned: true, generation: ++generation });
        else await driver.requestStop(task, { terminal: "canceled", reason: "owner_cancel", cancelIntent: true });
      }
      await running;
      assert.equal(calls.at(-1), "release");
      assert.equal(calls.filter(op => op === "open").length, 1);
      assert.equal(manager.state(task)?.owned, false); assert.equal(manager.state(task)?.heldSeen, false);
      assert.equal(kit.store.getTask(task.id)?.status, ending === "cancel" ? "canceled" : "completed", kit.store.getTask(task.id)?.errorMessage ?? kit.store.getTask(task.id)?.interruptReason ?? undefined);
      if (ending === "return") {
        const entries = parseSessionFile(kit.store.getSession(session.id)!.sessionFile!);
        assert.equal(entries.filter(entry => entry.type === "custom" && entry.customType === "ruukoto_browser_observation").length, 1);
        assert.match(JSON.stringify(kit.server.calls[1]?.messages), /Owner updated page/);
        assert.equal(calls.filter(op => op === "eval").length, 1);
      }
      if (ending === "lost-open") assert.equal(kit.store.getTask(task.id)?.effectUnknown, true);
    } finally { await driver.dispose(); await kit.close(); }
  });
}
