import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import { test } from "node:test";
import { ensureBackend, probeControlPlane } from "@ruukoto/control/ensure-backend.ts";
import { CONTROL_PROTOCOL_VERSION } from "@ruukoto/control/protocol.ts";
import { readOwnerToken, tokenMatches } from "@ruukoto/control/owner-token.ts";
import { cleanupDirs, makeTestDirs, waitFor } from "./helpers/testkit.ts";

async function fixture(reply: (op: string) => object | null) {
  const { dirs } = await makeTestDirs("control-readiness", 0);
  const { profile } = dirs;
  const { controlDir, socketPath } = profile;
  const token = readOwnerToken(controlDir);
  assert.ok(token);
  const operations: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string; op: string; params: { token?: string; product?: string; layout?: string; instanceId?: string } };
        buffer = buffer.slice(newline + 1);
        operations.push(request.op);
        if (request.op === "auth") authenticated = typeof request.params.token === "string" && tokenMatches(request.params.token, token) && request.params.product === "ruukoto" && request.params.layout === profile.layout && request.params.instanceId === profile.instanceId;
        const response = !authenticated ? { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
          : request.op === "auth" ? { ok: true, result: { authenticated: true, instanceId: profile.instanceId, layout: profile.layout, product: "ruukoto" } } : reply(request.op);
        if (response) socket.write(`${JSON.stringify({ v: CONTROL_PROTOCOL_VERSION, id: request.id, ...response })}\n`);
      }
    });
  });
  const listening = once(server, "listening");
  server.listen(socketPath);
  await listening;
  return {
    profile, token, sockets, operations,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await cleanupDirs(dirs);
    },
  };
}

test("就绪探测认证后只发 ping，随后关闭且不取快照", async () => {
  const f = await fixture(() => ({ ok: true, result: { pong: true, stopping: false } }));
  try {
    assert.equal(await probeControlPlane(f.profile, f.token), true);
    await waitFor("readiness connection closes", () => f.sockets.size === 0, 1500);
    assert.deepEqual(f.operations, ["auth", "ping"]);
  } finally { await f.close(); }
});

for (const [name, response, code] of [
  ["停止中", { ok: true, result: { pong: true, stopping: true } }, "backend_stopping"],
  ["畸形响应", { ok: true, result: { pong: true } }, "invalid_response"],
  ["空响应", { ok: true, result: null }, "invalid_response"],
  ["错误 pong", { ok: true, result: { pong: false, stopping: false } }, "invalid_response"],
  ["ping 明确拒绝", { ok: false, error: { code: "unauthorized", message: "rejected" } }, "unauthorized"],
  ["ping 版本拒绝", { v: CONTROL_PROTOCOL_VERSION + 1, ok: false, error: { code: "protocol_version", message: "different version" } }, "protocol_version"],
] as const) {
  test(`${name}不能视为就绪或重复拉起后台`, async () => {
    const f = await fixture(() => response);
    const previous = { token: process.env.RUUKOTO_OWNER_TOKEN, file: process.env.RUUKOTO_OWNER_TOKEN_FILE };
    delete process.env.RUUKOTO_OWNER_TOKEN;
    delete process.env.RUUKOTO_OWNER_TOKEN_FILE;
    try {
      assert.equal(await probeControlPlane(f.profile, f.token, 200), false);
      const result = await ensureBackend({ profile: f.profile, spawnExecPath: "/must-not-spawn" });
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.code === code);
      assert.equal(fs.existsSync(f.profile.spawnLogPath), false);
      await waitFor("rejected readiness connections close", () => f.sockets.size === 0, 1500);
      assert.deepEqual(f.operations, ["auth", "ping", "auth", "ping"]);
      if (!result.ok && code === "protocol_version") assert.deepEqual(result.versions, { client: CONTROL_PROTOCOL_VERSION, server: CONTROL_PROTOCOL_VERSION + 1 });
    } finally {
      if (previous.token === undefined) delete process.env.RUUKOTO_OWNER_TOKEN; else process.env.RUUKOTO_OWNER_TOKEN = previous.token;
      if (previous.file === undefined) delete process.env.RUUKOTO_OWNER_TOKEN_FILE; else process.env.RUUKOTO_OWNER_TOKEN_FILE = previous.file;
      await f.close();
    }
  });
}

test("ping 使用探测期限，超时不会沿默认请求期限挂起", async () => {
  const f = await fixture(() => null);
  try {
    const started = Date.now();
    assert.equal(await probeControlPlane(f.profile, f.token, 40), false);
    assert.ok(Date.now() - started < 1500);
    await waitFor("timed-out readiness connection closes", () => f.sockets.size === 0, 1500);
    assert.deepEqual(f.operations, ["auth", "ping"]);
  } finally { await f.close(); }
});
