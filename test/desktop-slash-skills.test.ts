import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";

let server: ViteDevServer;
let commands: (input: { model: CodeState; text: string; edit: (text: string) => void; input: { current: HTMLTextAreaElement | null }; locked: boolean }) => unknown;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  ({ useComposerCommands: commands } = await server.ssrLoadModule("/composer-commands.tsx"));
});
after(async () => { await server?.close(); });

for (const changedRevision of [false, true]) test(`skill discovery ${changedRevision ? "rejects a changed revision without installing partial pages" : "joins all catalog pages"}`, async context => {
  const pages = [Array.from({ length: 50 }, (_, index) => ({ name: `skill-${index}`, description: "First page" })), [{ name: "second-page-skill", description: "Second page" }]];
  const requests: Record<string, unknown>[] = [];
  const request = async (target: string, op: string, params: Record<string, unknown>) => {
    assert.equal(target, "code"); assert.equal(op, "skills_list"); requests.push(params);
    const second = params.offset === 50;
    return { ok: true as const, value: { skills: pages[second ? 1 : 0], revision: second && changedRevision ? "new" : "original", hasMore: !second } };
  };
  const model = new CodeState({ request }, () => {});
  model.view.applySnapshot({ snapshot: fakeSnapshot(), replay: [], seq: 0 }, false);
  model.status = { type: "state", state: "online" };
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ruukoto: { request } } });
  context.after(() => { if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else Reflect.deleteProperty(globalThis, "window"); });
  const internals = (React as typeof React & { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H, cells: unknown[] = [], effects: (() => void | (() => void))[] = [];
  let cursor = 0;
  // Capture the real hook's state and effects without mounting its menu.
  internals.H = {
    useState(initial: unknown) { const index = cursor++; cells[index] = initial; return [initial, (value: unknown) => { cells[index] = typeof value === "function" ? value(cells[index]) : value; }]; },
    useRef(current: unknown) { return { current }; },
    useId() { return "skill-discovery"; },
    useEffect(effect: () => void | (() => void)) { effects.push(effect); },
  };
  try { commands({ model, text: "/skill ", edit() {}, input: { current: null }, locked: false }); }
  finally { internals.H = previous; }
  const cleanups = effects.map(effect => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === "function");
  context.after(() => cleanups.forEach(cleanup => cleanup()));
  await waitFor("skill discovery result", () => changedRevision ? typeof cells[6] === "string" && cells[6].length > 0 : Array.isArray(cells[5]) && cells[5].length === 51);
  assert.deepEqual(requests, [{ offset: 0, limit: 50 }, { offset: 50, limit: 50 }]);
  if (changedRevision) {
    assert.deepEqual(cells[5], []);
    assert.match(String(cells[6]), /library changed.*Reopen \/skill/);
  } else {
    assert.deepEqual(cells[5], [...pages[0], ...pages[1]]);
    assert.equal(cells[6], "");
  }
});
