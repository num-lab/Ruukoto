import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { PersonalController } from "../../../apps/desktop/src/main/personal-controller.ts";
import { savePersonalConfig } from "../../../apps/desktop/src/main/personal-config.ts";
import { PersonalState } from "../../../apps/desktop/src/renderer/personal-state.ts";
import type { DesktopResult, DesktopUpdate } from "../../../apps/desktop/src/shared/bridge.ts";

const origin = "https://vnic-osaka-4c24g.tailf20ebf.ts.net";
const credential = JSON.parse(fs.readFileSync(0, "utf8")) as { id: string; secret: string };
assert.match(credential.id, /^[0-9a-f-]{36}$/); assert.match(credential.secret, /^[A-Za-z0-9_-]{43}$/);
const authorization = `Bearer ${credential.id}.${credential.secret}`;
async function handshake(auth: boolean) {
  return new Promise<{ status: number; identity: { v: 1; product: string; origin: string; remoteId: string; profile: { id: string; directory: string }; online: boolean; runId: string } }>((resolve, reject) => {
    const request = https.get(`${origin}/handshake`, { headers: auth ? { authorization, "tailscale-user-login": "forged@example.invalid" } : {} }, response => {
      const authorized = response.socket.authorized, chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => { assert.equal(authorized, true); const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); resolve({ status: response.statusCode!, identity: envelope.result }); });
    });
    request.on("error", reject); request.setTimeout(10_000, () => request.destroy(new Error("probe_timeout")));
  });
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 30_000;
  while (!check()) { assert(Date.now() < deadline, message); await delay(25); }
}
assert.equal((await handshake(false)).status, 401);
const accepted = await handshake(true); assert.equal(accepted.status, 200);
const identity = accepted.identity; assert.equal(identity.online, true); assert.equal(identity.product, "ruukoto"); assert.equal(identity.origin, origin);
const directory = fs.realpathSync(fs.mkdtempSync("/tmp/rkt-host-")); fs.chmodSync(directory, 0o700);
const config = savePersonalConfig(directory, { v: 1, origin, binding: { remoteId: identity.remoteId, profile: identity.profile } });
let raw = JSON.stringify({ v: 1, active: { ...credential, origin, remoteId: identity.remoteId, profile: identity.profile } });
const updates: DesktopUpdate[] = [];
let controller: PersonalController;
const state = new PersonalState({ request: async (_target, op, params): Promise<DesktopResult<unknown>> => {
  try {
    const value = op === "desktop_personal_request" ? await controller.business(params.method, params.path, params.body)
      : op === "desktop_personal_input_submit" ? await controller.submitInput(String(params.text))
      : op === "desktop_personal_input_restore" ? await controller.restoreInput()
      : op === "desktop_personal_input_reconcile" ? await controller.reconcileInput()
      : undefined;
    return { ok: true, value };
  } catch (error) { return { ok: false, error: { code: error instanceof Error && "code" in error ? String(error.code) : "probe_failed", message: "隔离请求未核实", outcome: "unknown" } }; }
} }, () => {});
controller = new PersonalController(config, directory, update => { updates.push(update); state.update(update); }, { read: async () => raw, write: async value => { raw = value; }, remove: async () => { raw = ""; } });
let passed = false;
try {
  state.start(); await controller.reconnect();
  await until(() => state.online, "personal_snapshot_not_ready");
  const baseline = Math.max(0, ...state.timeline.map(entry => entry.entry));
  state.edit("隔离 tailnet 文本闭环"); await state.send();
  await until(() => state.timeline.some(entry => entry.entry > baseline && entry.role === "assistant" && entry.text.includes("隔离链路测试完成")), "assistant_entry_not_projected");
  assert.equal(state.draft, "");
  assert.equal(JSON.stringify(updates).includes(credential.secret), false);
  assert.equal(updates.some(update => update.type === "snapshot" || update.type === "event"), false);
  const settings = await controller.request("GET", "/management") as { settings: { online: boolean; model: { config: { modelId: string } } } };
  assert.equal(settings.settings.online, true); assert.equal(settings.settings.model.config.modelId, "tailnet-fixture");
  passed = true;
  process.stdout.write(`${JSON.stringify({ checks: ["system_tls_and_sni", "missing_credential_401", "serve_overwrites_identity", "native_host_handshake", "native_ws_snapshot", "text_submission_and_stream", "renderer_final_entry", "same_address_settings", "no_secret_in_updates", "no_code_projection"], entries: state.timeline.length, frames: updates.filter(update => update.type === "personal_frame").length, realModel: false, realIm: false })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: state.status.state, code: state.status.error?.code, ready: state.ready, draftLength: state.draft.length, pendingId: state.pending?.requestId, entries: state.timeline.map(entry => ({ entry: entry.entry, role: entry.role, chars: entry.text.length })), frames: updates.filter(update => update.type === "personal_frame").map(update => ({ seq: update.frame.seq, type: update.frame.type, ...(update.frame.type === "events" ? { events: update.frame.events.map(event => event.type) } : {}) })), retainedDirectory: directory })}\n`);
  throw error;
} finally { state.dispose(); await controller.close(); if (passed) fs.rmSync(directory, { recursive: true, force: true }); }
