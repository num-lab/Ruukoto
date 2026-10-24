import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { savePersonalConfig } from "./apps/ruukoto/src/personal-config.ts";
import { initializePersonalRemote } from "./apps/ruukoto/src/personal-remote.ts";
import { personalSettingsDirectoryIdentity } from "./apps/ruukoto/src/personal-settings.ts";

const directory = "/var/lib/rktest/profile", remote = "/home/rktest/.config/ruukoto-remote";
const mode = process.argv[2];
if (mode === "setup") {
  await savePersonalConfig(directory, { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", modelId: "fixture-original", apiKeyEnv: "RK_TEST_KEY", contextWindow: 128000, maxTokens: 1024 });
  await initializePersonalRemote({ v: 1, origin: "https://vnic-osaka-4c24g.tailf20ebf.ts.net", owner: "eitrous9961@gmail.com", profile: personalSettingsDirectoryIdentity(directory) }, () => "/home/rktest");
  process.stdout.write("fixture_initialized\n");
} else if (mode === "test") {
  const filename = "/var/lib/rktest/fixture-credential.json", existingCandidate = fs.existsSync(filename);
  const key = existingCandidate ? JSON.parse(fs.readFileSync(filename, "utf8")) : { id: randomUUID(), secret: randomBytes(32).toString("base64url") };
  if (!existingCandidate) {
    const raw = JSON.stringify(key), fd = fs.openSync(filename, "wx", 0o600);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    assert.equal(fs.readFileSync(filename, "utf8"), raw);
  }
  const headers: http.OutgoingHttpHeaders = { "tailscale-user-login": "eitrous9961@gmail.com", authorization: `Bearer ${key.id}.${key.secret}` };
  type Envelope = { ok: boolean; code?: string; result: any };
  function begin(route: string, body?: unknown, admin = false) {
    const request = http.request({ socketPath: `${remote}/${admin ? "admin" : "remote"}.sock`, method: body === undefined ? "GET" : "POST", path: route, headers: { ...(admin ? {} : headers), "content-type": "application/json", connection: "close" } });
    const done = new Promise<Envelope>((resolve, reject) => {
      request.on("error", reject);
      request.on("response", response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
        response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error("probe_timeout")));
    request.end(body === undefined ? undefined : JSON.stringify(body));
    return { request, done };
  }
  async function call(route: string, body?: unknown, admin = false) {
    const value = await begin(route, body, admin).done;
    assert.equal(value.ok, true, value.code);
    return value.result;
  }
  async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, budget = 30_000): Promise<T> {
    const deadline = Date.now() + budget;
    while (true) {
      const value = await read();
      if (accept(value)) return value;
      assert(Date.now() < deadline, "probe_wait_timeout"); await delay(25);
    }
  }
  if (!existingCandidate) {
    const window = await call("/pair/open", {}, true);
    await call("/pair", { v: 1, code: window.code, label: "isolated-systemd-probe" });
  }
  const identity = await call("/handshake");
  headers["x-ruukoto-remote-id"] = identity.remoteId; headers["x-ruukoto-profile-id"] = identity.profile.id;
  await until(() => call("/handshake"), value => value.online === true);
  async function draft(label: string) {
    const view = await call("/management");
    assert.equal(view.maintenance.writable, true, view.maintenance.code);
    return { v: 1, op: "config.save", target: "model", profile: identity.profile, expectedRevision: view.settings.revisions.model, value: { ...view.settings.model.config, modelId: label } };
  }
  const checks: string[] = [];
  const firstId = randomUUID(), first = await draft("fixture-A");
  await call("/maintenance", { v: 1, id: firstId, request: first });
  const firstReceipt = await until(() => call(`/maintenance?id=${firstId}`), value => value.stage === "complete");
  assert.equal(firstReceipt.saved, true); assert.equal(firstReceipt.started, true);
  const secondId = randomUUID();
  await call("/maintenance", { v: 1, id: secondId, request: await draft("fixture-B") });
  await until(() => call(`/maintenance?id=${secondId}`), value => value.stage === "complete");
  assert.deepEqual(await call("/maintenance", { v: 1, id: firstId, request: first }), firstReceipt);
  assert.equal((await call("/management")).settings.model.config.modelId, "fixture-B");
  checks.push("real_systemd_stop_save_start", "late_A_after_B_original_receipt", "backend_token_rotation");
  for (const stage of ["stopping", "saving", "saved", "starting"]) {
    const id = randomUUID(), request = await draft(`disconnect-${stage}`);
    fs.rmSync("/var/lib/rktest/observed.json", { force: true });
    fs.writeFileSync("/var/lib/rktest/gate.json", JSON.stringify({ id, stage, action: "pause" }), { mode: 0o600 });
    const pending = begin("/maintenance", { v: 1, id, request });
    const outcome = pending.done.then(() => true, () => false);
    await until(async () => fs.existsSync("/var/lib/rktest/observed.json"), Boolean);
    pending.request.destroy();
    fs.unlinkSync("/var/lib/rktest/gate.json"); await outcome;
    const receipt = await until(() => call(`/maintenance?id=${id}`), value => value.stage === "complete");
    assert.equal(receipt.saved, true); assert.equal(receipt.started, true);
    checks.push(`client_disconnect_${stage}_continues`); process.stdout.write(`${JSON.stringify({ event: "disconnect_verified", stage })}\n`);
  }
  for (const stage of ["stopping", "stopped", "saving", "saved", "starting"]) {
    const id = randomUUID(), request = await draft(`crash-${stage}`), before = fs.readFileSync(`${directory}/model.json`, "utf8");
    fs.rmSync("/var/lib/rktest/observed.json", { force: true });
    fs.writeFileSync("/var/lib/rktest/gate.json", JSON.stringify({ id, stage, action: "crash" }), { mode: 0o600 });
    await begin("/maintenance", { v: 1, id, request }).done.catch(() => undefined);
    await until(async () => fs.existsSync("/var/lib/rktest/observed.json"), Boolean);
    const observed = JSON.parse(fs.readFileSync("/var/lib/rktest/observed.json", "utf8")); assert.equal(observed.stage, stage);
    await until(async () => execFileSync("/usr/bin/systemctl", ["show", "--property=ActiveState", "--value", "ruukoto-remote.service"], { encoding: "utf8" }).trim(), state => state === "failed" || state === "inactive");
    execFileSync("sudo", ["-n", "/usr/bin/systemctl", "start", "ruukoto-remote.service"]);
    await until(async () => { try { return await call(`/maintenance?id=${id}`); } catch { return null; } }, value => value !== null);
    const retained = await call(`/maintenance?id=${id}`);
    assert.equal(retained.stage, stage);
    await delay(100); assert.equal((await call(`/maintenance?id=${id}`)).stage, stage);
    assert.deepEqual(await call("/maintenance", { v: 1, id, request }), retained);
    if (["stopping", "stopped", "saving"].includes(stage)) assert.equal(fs.readFileSync(`${directory}/model.json`, "utf8"), before);
    const recovered = await call("/maintenance/restore", { v: 1, id });
    if (recovered.stage !== "complete") await call("/maintenance/finish", { v: 1, id });
    assert.equal((await call(`/maintenance?id=${id}`)).stage, "complete");
    assert.equal((await call("/handshake")).online, true);
    checks.push(`remote_crash_${stage}_no_resave`); process.stdout.write(`${JSON.stringify({ event: "crash_verified", stage })}\n`);
  }
  const failureId = randomUUID(), failureRequest = await draft("fixture-start-failure");
  fs.rmSync("/var/lib/rktest/observed.json", { force: true });
  fs.writeFileSync("/var/lib/rktest/gate.json", JSON.stringify({ id: failureId, stage: "saved", action: "pause" }), { mode: 0o600 });
  const admitted = begin("/maintenance", { v: 1, id: failureId, request: failureRequest }).done;
  await until(async () => fs.existsSync("/var/lib/rktest/observed.json"), Boolean);
  process.stdout.write(`${JSON.stringify({ event: "configure_start_failure" })}\n`);
  await until(async () => fs.existsSync("/var/lib/rktest/unit-ready"), Boolean, 90_000);
  fs.unlinkSync("/var/lib/rktest/gate.json"); await admitted;
  const failed = await until(() => call(`/maintenance?id=${failureId}`), value => !!value.code);
  assert.equal(failed.saved, true); assert.equal(failed.started, false); assert.equal(failed.stage, "starting");
  process.stdout.write(`${JSON.stringify({ event: "restore_start_configuration", code: failed.code })}\n`);
  await until(async () => fs.existsSync("/var/lib/rktest/unit-restored"), Boolean, 90_000);
  const restored = await call("/maintenance/restore", { v: 1, id: failureId });
  assert.equal(restored.stage, "complete"); assert.equal(restored.savedRevision, failed.savedRevision);
  assert.equal((await call("/management")).settings.model.config.modelId, "fixture-start-failure");
  checks.push("real_start_failure_retains_saved_and_restore_does_not_save");
  process.stdout.write(`${JSON.stringify({ checks, modelCalls: 0, realIm: false })}\n`);
} else throw new Error("Use setup or test inside the isolated systemd container");
