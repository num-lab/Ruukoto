import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createServer, type ViteDevServer } from "./helpers/vite.ts";
import react from "@vitejs/plugin-react";
import type { Session } from "@ruukoto/core/types.ts";
import type { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";

let server: ViteDevServer;
let App: () => React.ReactNode;
let CodeModel: typeof CodeState;
let Composer: React.ComponentType<{ model: CodeState; session: Session }>;
let Conversation: React.ComponentType<{ model: CodeState; sessionId: string }>;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  ({ App } = await server.ssrLoadModule("/app.tsx"));
  ({ CodeState: CodeModel } = await server.ssrLoadModule("/code-state.ts"));
  ({ Composer } = await server.ssrLoadModule("/composer.tsx"));
  ({ Conversation } = await server.ssrLoadModule("/conversation.tsx"));
});
after(async () => { await server?.close(); });

const session: Session = { id: "offline-session", projectId: "workspace", kind: "dev", name: "Offline conversation", branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, queueRevision: 0, archivedAt: null, createdAt: "2026-11-08T00:00:00.000Z" };
function nodes(tree: React.ReactNode): React.ReactElement<{ children?: React.ReactNode; className?: string; role?: string; model?: CodeState; session?: Session; sessionId?: string }>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement<{ children?: React.ReactNode; className?: string; role?: string; model?: CodeState; session?: Session; sessionId?: string }>(tree)) return [];
  return [tree, ...nodes(tree.props.children)];
}

for (const hasCurrent of [true, false]) test(`offline App ${hasCurrent ? "retains its conversation composer and draft" : "retains the connection empty state without a conversation"}`, context => {
  let model: CodeState | undefined;
  const attachment = { id: "file", name: "unsent.txt", size: 12 };
  // Capture the real App tree without mounting children or running connection effects.
  const internals = (React as typeof React & { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ruukoto: { request: async () => { throw new Error("Offline rendering must not send requests"); } } } });
  context.after(() => { if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else Reflect.deleteProperty(globalThis, "window"); });
  internals.H = {
    useState(initial: unknown) {
      const value = typeof initial === "function" ? initial() : initial;
      if (value && typeof value === "object" && "code" in value && value.code instanceof CodeModel) {
        const code = value.code;
        model = code;
        code.view.applySnapshot({ snapshot: fakeSnapshot({ sessions: hasCurrent ? [session] : [] }), replay: [], seq: 0 }, false);
        code.view.currentSessionId = hasCurrent ? session.id : null;
        code.status = { type: "state", state: "reconnecting", detail: "Disconnected fixture" };
        Object.assign(code.writes.draft(session.id), { text: "/help", attachments: [attachment] });
      }
      return [value, () => {}];
    },
    useRef(current: unknown) { return { current }; },
    useEffect() {},
  };
  let tree: React.ReactNode;
  try { tree = App(); } finally { internals.H = previous; }
  assert.ok(model);
  const elements = nodes(tree);
  const composers = elements.filter(node => node.type === Composer);
  const conversations = elements.filter(node => node.type === Conversation);
  assert.equal(composers.length, hasCurrent ? 1 : 0);
  assert.equal(conversations.length, hasCurrent ? 1 : 0);
  assert.equal(elements.some(node => node.props.className === "empty-state"), !hasCurrent);
  if (hasCurrent) {
    assert.equal(composers[0].props.model, model);
    assert.equal(composers[0].props.session?.id, session.id);
    assert.equal(conversations[0].props.sessionId, session.id);
    assert.equal(model.writes.draft(session.id).text, "/help");
    assert.deepEqual(model.writes.draft(session.id).attachments, [attachment]);
    assert.ok(elements.some(node => node.props.role === "status" && nodes(node).some(child => child.type === "span" && child.props.children === "Disconnected fixture")));
  }
});
