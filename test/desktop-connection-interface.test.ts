import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import { adoptEnvironment } from "../apps/desktop/src/main/environment.ts";
import type { DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";

import { startTestRuntime, waitFor } from "./helpers/testkit.ts";
import { profileChildEnv } from "@ruukoto/core/profile.ts";

test("Attachment selection is fenced by the original connection across same-instance reconnect", { timeout: 30000 }, async t => {
  const previous = { ...process.env };
  const code = await startTestRuntime("desktop-interface", () => ({ kind: "text", text: "ruukoto" }));
  const opened = await code.runtime.openWorkspace({ cwd: code.work[0] });
  const env = profileChildEnv(code.runtime.config.profile.selection, { ...previous, RUUKOTO_DESKTOP_MANAGED: "1" });
  const updates: DesktopUpdate[] = [];
  const host = new DesktopHost(path.resolve(import.meta.dirname, ".."), path.join(code.dirs.root, "desktop"), { publish: (_target, update) => { updates.push(update); }, focused: () => true, notice() {}, badge() {} }, async () => ({ env, node: process.execPath }));
  t.after(async () => { await host.close(); await code.shutdown(); adoptEnvironment(previous); });
  const online = () => updates.filter(update => update.type === "state").at(-1)?.state === "online";
  host.subscribe("code");
  await waitFor("desktop online", online);
  const selected = path.join(code.work[0], "selected.txt"); fs.writeFileSync(selected, "selected bytes");
  const [attachment] = await host.pickAttachments(opened.session.id, async () => [selected]);
  assert.equal(code.runtime.attachments.prepare(opened.session.id, [attachment])[0].bytes.toString(), "selected bytes");
  const connection = host.attachmentInstance();
  await assert.rejects(host.pickAttachments(opened.session.id, async () => { await host.request("code", "reconnect", {}); await waitFor("reconnected", online); return [selected]; }, connection), { code: "attachment_instance_changed" });
  assert.notEqual(host.attachmentInstance(), connection);
  assert.throws(() => host.pickAttachments(opened.session.id, async () => assert.fail("stale selection must not open picker"), connection), { code: "attachment_instance_changed" });
  assert.equal((await host.request("code", "get_session", { session_id: opened.session.id })).ok, true);
});
