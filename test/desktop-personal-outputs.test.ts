import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import tls from "node:tls";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { PersonalDesktopOutput, PersonalDesktopOutputChunk } from "@ruukoto/view/personal-protocol.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import { DesktopError } from "../apps/desktop/src/main/environment.ts";
import { PERSONAL_OUTPUT_BYTES, PERSONAL_OUTPUT_CHUNK_BYTES, personalOutputMetadata, readPersonalOutput, savePersonalOutput } from "../apps/desktop/src/main/personal-outputs.ts";
import { desktopRemoteFixture } from "./helpers/personal-remote-desktop.ts";
import { personalTestCertificate } from "./helpers/personal-https.ts";

const code = (expected: string) => (error: unknown) => (error instanceof DesktopError || error instanceof ControlClientError) && error.code === expected;
function output(bytes: Buffer): PersonalDesktopOutput { return { v: 1, publication: 200, output: 100, name: "final.txt", mime: "text/plain", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), partial: false }; }
function chunk(bytes: Buffer, offset: number, saved = output(bytes)): PersonalDesktopOutputChunk { const part = bytes.subarray(offset, offset + PERSONAL_OUTPUT_CHUNK_BYTES), next = offset + part.length; return { ...saved, offset, base64: part.toString("base64"), ...(next < bytes.length ? { nextOffset: next } : {}) }; }

test("Final-output transfer verifies complete bytes, canonical chunks and SHA-256 through the 8MiB boundary", async () => {
  for (const size of [0, PERSONAL_OUTPUT_CHUNK_BYTES, PERSONAL_OUTPUT_BYTES]) {
    const bytes = Buffer.alloc(size, 0xa7), offsets: number[] = [];
    const result = await readPersonalOutput(200, 100, async offset => { offsets.push(offset); return chunk(bytes, offset); });
    assert.deepEqual(result.metadata, output(bytes)); assert.deepEqual(result.bytes, bytes);
    assert.equal(offsets.length, Math.max(1, Math.ceil(size / PERSONAL_OUTPUT_CHUNK_BYTES)));
    assert.deepEqual(offsets, offsets.map((_offset, index) => index * PERSONAL_OUTPUT_CHUNK_BYTES));
  }
});

test("Incomplete, oversized, corrupted or discontinuous output cannot be represented as a complete file", async t => {
  const bytes = Buffer.alloc(PERSONAL_OUTPUT_CHUNK_BYTES + 9, 0xa7);
  const cases = {
    "foreign output": (page: PersonalDesktopOutputChunk) => ({ ...page, output: 101 }),
    "foreign publication": (page: PersonalDesktopOutputChunk) => ({ ...page, publication: 201 }),
    "remote path name": (page: PersonalDesktopOutputChunk) => ({ ...page, name: "/private/result.txt" }),
    "partial output": (page: PersonalDesktopOutputChunk) => ({ ...page, partial: true }),
    "oversized output": (page: PersonalDesktopOutputChunk) => ({ ...page, bytes: PERSONAL_OUTPUT_BYTES + 1 }),
    "wrong hash": (page: PersonalDesktopOutputChunk) => ({ ...page, sha256: "0".repeat(64) }),
    "missing next page": (page: PersonalDesktopOutputChunk) => ({ ...page, nextOffset: undefined }),
    "skipped next page": (page: PersonalDesktopOutputChunk) => ({ ...page, nextOffset: page.nextOffset === undefined ? undefined : page.nextOffset + 1 }),
    "noncanonical base64": (page: PersonalDesktopOutputChunk) => ({ ...page, base64: ` ${page.base64}` }),
    "extra bytes": (page: PersonalDesktopOutputChunk) => ({ ...page, base64: Buffer.concat([Buffer.from(page.base64, "base64"), Buffer.from([1])]).toString("base64") }),
    "metadata changes": (page: PersonalDesktopOutputChunk) => ({ ...page, ...(page.offset ? { name: "changed.txt" } : {}) }),
    "same-size corruption": (page: PersonalDesktopOutputChunk) => ({ ...page, base64: Buffer.alloc(Buffer.from(page.base64, "base64").length, 0xa8).toString("base64") }),
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => { await assert.rejects(readPersonalOutput(200, 100, async offset => change(chunk(bytes, offset))), error => error instanceof DesktopError); });
  for (const name of ["..", ".", "a/b", "a\\b", "hidden\0.txt", " ", "a".repeat(129)]) assert.equal(personalOutputMetadata({ ...output(bytes), name }), false);
});

test("A verified output save atomically replaces the chosen file and preserves it when the connection changes", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rk-output-save-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "chosen.txt"), bytes = Buffer.from("complete final content\n"); fs.writeFileSync(destination, "old");
  await savePersonalOutput(destination, bytes, () => {});
  assert.deepEqual(fs.readFileSync(destination), bytes); assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  await assert.rejects(savePersonalOutput(destination, Buffer.from("stale"), () => { throw new ControlClientError("personal_output_identity_changed", "Changed", "not_sent"); }), code("personal_output_identity_changed"));
  assert.deepEqual(fs.readFileSync(destination), bytes); assert.deepEqual(fs.readdirSync(directory), ["chosen.txt"]);
  await assert.rejects(savePersonalOutput(path.join(directory, "missing", "file"), bytes, () => {}), error => error instanceof DesktopError && error.code === "personal_output_save_failed" && !error.message.includes(directory));
});

test("Real authenticated output chunks reject cross-profile requests, revocation and reconnect without business replay", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair("ABCDEFGHIJKL", "output-fixture");
  const bytes = Buffer.alloc(PERSONAL_OUTPUT_CHUNK_BYTES + 9, 0x82), offsets: number[] = [];
  let mode = "normal", requests = 0;
  f.overrides.set("/desktop/output", async (request, response) => {
    assert.equal(request.method, "GET"); const url = new URL(request.url!, f.origin), offset = Number(url.searchParams.get("offset"));
    assert.equal(url.searchParams.get("publication"), "200"); assert.equal(url.searchParams.get("output"), "100"); offsets.push(offset); requests++;
    if (mode === "disconnect" && offset) { request.socket.destroy(); return; }
    f.respond(response, chunk(bytes, offset));
    if (mode === "revoke" && !offset) f.state.revoked = true;
  });
  const input = { origin: f.origin, remoteId: f.remoteId, profileId: f.profile.id, publication: 200, output: 100 };
  const completed = await controller.output(input); assert.deepEqual(completed.bytes, bytes); await completed.revalidate(); assert.deepEqual(offsets, [0, PERSONAL_OUTPUT_CHUNK_BYTES, 0]);
  for (const changed of [{ ...input, profileId: "foreign" }, { ...input, remoteId: "foreign" }, { ...input, origin: "https://foreign.invalid" }, { ...input, path: "/private/file" }]) await assert.rejects(controller.output(changed), error => code("personal_output_identity_changed")(error) || code("personal_output_invalid")(error));
  assert.equal(requests, 3);
  mode = "disconnect"; await assert.rejects(controller.output(input), code("personal_connection_lost")); assert.equal(requests, 5);
  mode = "normal"; const retried = await controller.output(input); assert.deepEqual(retried.bytes, bytes); assert.equal(requests, 7);
  mode = "revoke"; await assert.rejects(controller.output(input), error => code("remote_credential_revoked")(error) || code("personal_identity_changed")(error)); assert.equal(controller.status.state, "failed"); assert.deepEqual(f.state.inputCalls, []);
});

test("Both-host output actions keep native chooser paths private, recheck revocation after choosing and clean native previews", async t => {
  const ca = tls.getCACertificates(); t.after(() => tls.setDefaultCACertificates(ca));
  const f = await desktopRemoteFixture(t), pairing = f.create(); await pairing.pair("ABCDEFGHIJKL", "native-output"); await pairing.close(); tls.setDefaultCACertificates([...ca, personalTestCertificate]);
  const bytes = Buffer.from("verified native output\n"), destination = path.join(f.directory, "saved.txt"); fs.writeFileSync(destination, "old");
  let revokeInChooser = false, cancelChooser = false, chooseCalls = 0, previewPath = "", closed = 0;
  f.overrides.set("/desktop/output", (request, response) => { const offset = Number(new URL(request.url!, f.origin).searchParams.get("offset")); f.respond(response, chunk(bytes, offset)); });
  const host = new DesktopHost(process.cwd(), f.directory, { publish() {}, focused: () => true, notice() {}, badge() {}, credentials: f.storage,
    pickOutput: async name => { assert.equal(name, "final.txt"); chooseCalls++; if (revokeInChooser) f.state.revoked = true; return cancelChooser ? null : destination; },
    previewOutput: async (filename, name) => { assert.equal(name, "final.txt"); assert.deepEqual(fs.readFileSync(filename), bytes); assert.equal(fs.statSync(filename).mode & 0o777, 0o600); previewPath = filename; return () => { closed++; }; },
  }, async () => ({ env: { ...process.env }, node: process.execPath })); t.after(() => host.close()); await host.reconnectPersonal();
  const input = { origin: f.origin, remoteId: f.remoteId, profileId: f.profile.id, publication: 200, output: 100 };
  let permissionPosts = 0;
  f.overrides.set("/permissions", (request, response) => { if (request.method === "POST") permissionPosts++; f.respond(response, { default: { mode: "confirm" } }); });
  const connection = pairing.config;
  for (const stale of [{ ...connection, origin: "https://foreign.invalid" }, { ...connection, binding: { ...connection.binding!, remoteId: "foreign" } }, { ...connection, binding: { ...connection.binding!, profile: { ...connection.binding!.profile, id: "foreign" } } }]) {
    const rejected = await host.request("personal", "desktop_personal_request", { method: "POST", path: "/permissions", body: { mode: "full_access" }, connection: stale });
    assert.equal(rejected.ok, false); if (!rejected.ok) { assert.equal(rejected.error.code, "personal_identity_changed"); assert.equal(rejected.error.outcome, "not_sent"); }
  }
  assert.equal(permissionPosts, 0);
  assert.equal((await host.request("personal", "desktop_personal_request", { method: "GET", path: "/permissions", connection })).ok, true);
  assert.equal((await host.request("personal", "desktop_personal_request", { method: "POST", path: "/permissions", body: { mode: "confirm" }, connection })).ok, true); assert.equal(permissionPosts, 1);
  const saved = await host.request("personal", "desktop_personal_output_save", input); assert.deepEqual(saved, { ok: true, value: { state: "saved" } }); assert.deepEqual(fs.readFileSync(destination), bytes); assert.equal(JSON.stringify(saved).includes(destination), false);
  for (const bad of [{ ...input, filename: destination }, { ...input, base64: bytes.toString("base64") }]) { const rejected = await host.request("personal", "desktop_personal_output_save", bad); assert.equal(rejected.ok, false); } assert.equal(chooseCalls, 1);
  cancelChooser = true; const canceled = await host.request("personal", "desktop_personal_output_save", input); assert.deepEqual(canceled, { ok: true, value: { state: "canceled" } }); cancelChooser = false;
  const preview = await host.request("personal", "desktop_personal_output_preview", input); assert.deepEqual(preview, { ok: true, value: { state: "previewed" } }); assert.ok(fs.existsSync(previewPath));
  const previousPreview = previewPath; await host.request("personal", "desktop_personal_output_preview", input); assert.equal(closed, 1); assert.equal(fs.existsSync(previousPreview), false);
  revokeInChooser = true; fs.writeFileSync(destination, "preserved"); const revoked = await host.request("personal", "desktop_personal_output_save", input); assert.equal(revoked.ok, false); assert.equal(fs.readFileSync(destination, "utf8"), "preserved");
  await host.close(); assert.equal(closed, 2); assert.equal(fs.existsSync(previewPath), false); assert.deepEqual(f.state.inputCalls, []);
});
