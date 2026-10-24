import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { PersonalCredentialPipe } from "../apps/desktop/src/mygo/personal-credential-pipe.ts";
const generation = "ab".repeat(16);

test("凭据专用帧等待原代次，串行关联且不接受坏帧或外壳服务名", async () => {
  const sent: Record<string, unknown>[] = [];
  const pipe = new PersonalCredentialPipe(async frame => { sent.push(frame as Record<string, unknown>); });
  try {
    const reading = pipe.read(); await setImmediate(); assert.equal(sent.length, 0);
    assert.equal(pipe.receive({ kind: "credential_ready", v: 1, generation }), true);
    await setImmediate(); assert.deepEqual(sent[0], { kind: "credential_request", v: 1, generation, id: 1, op: "read" });
    assert.equal(pipe.receive({ kind: "credential_result", v: 1, generation, id: 1, result: { ok: true, value: null } }), true); assert.equal(await reading, null);
    const writing = pipe.write("private JSON"); const removing = pipe.remove(); await setImmediate(); assert.equal(sent.length, 2); assert.equal(sent[1].value, "private JSON");
    pipe.receive({ kind: "credential_result", v: 1, generation, id: 2, result: { ok: true, value: null } }); await writing; await setImmediate(); assert.equal(sent.length, 3);
    pipe.receive({ kind: "credential_result", v: 1, generation, id: 3, result: { ok: false, code: "personal_credentials_unavailable" } }); await assert.rejects(removing, { code: "personal_credentials_unavailable" });
    assert.throws(() => pipe.receive({ kind: "credential_result", v: 1, generation: "cd".repeat(16), id: 3, result: { ok: true, value: "late secret" } }), { code: "bridge_invalid" });
    assert.equal(pipe.receive({ kind: "update", update: {} }), false);
  } finally { pipe.close(); }
});

test("超时或断线拒绝全部未决，晚到秘密不交给新调用", async () => {
  const pipe = new PersonalCredentialPipe(async () => {}, 15);
  pipe.receive({ kind: "credential_ready", v: 1, generation });
  const result = pipe.read();
  await assert.rejects(result, { code: "personal_credentials_unavailable" });
  assert.equal(pipe.receive({ kind: "credential_result", v: 1, generation, id: 1, result: { ok: true, value: "late secret" } }), true);
  await assert.rejects(pipe.read(), { code: "personal_credentials_unavailable" });
  const disconnected = new PersonalCredentialPipe(async () => { throw new Error("pipe closed"); });
  disconnected.receive({ kind: "credential_ready", v: 1, generation });
  await assert.rejects(disconnected.write("secret"), { code: "personal_credentials_unavailable" });
});
