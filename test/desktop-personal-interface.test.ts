import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import { savePersonalConfig } from "../apps/desktop/src/main/personal-config.ts";
import { adoptEnvironment } from "../apps/desktop/src/main/environment.ts";
import type { DesktopTarget, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";

test("双后台的附件与 pending 路由隔离，选择期间同实例重连拒绝原连接结果", async () => {
  const previous = { ...process.env };
  const code = await startTestRuntime("pa-host-code", () => ({ kind: "text", text: "Code" }), { config: { product: codeProduct.runtime } });
  const personal = await startTestRuntime("pa-host-main", () => ({ kind: "text", text: "PA" }));
  const temporary = fs.mkdtempSync("/tmp/rk-pa-host-");
  const controlDir = path.join(temporary, "control"), userData = path.join(temporary, "app");
  fs.mkdirSync(controlDir);
  fs.symlinkSync(path.join(code.runtime.controlDir(), "owner.token"), path.join(controlDir, "owner.token"));
  fs.symlinkSync(code.runtime.socketPath(), path.join(controlDir, "control.sock"));
  // SSH 仅替换传输进程，两端仍通过真实 ControlServer 认证与上传。
  fs.writeFileSync(path.join(temporary, "ssh"), `#!${process.execPath}
const fs=require('node:fs'), net=require('node:net');
const args=process.argv.slice(2);
if (!args.includes('-N')) process.stdout.write(fs.readFileSync(process.env.PA_TOKEN_FILE));
else {
 const local=args[args.indexOf('-L')+1].split(':')[0];
 fs.rmSync(local,{force:true});
 net.createServer(client=>{
  const remote=net.connect(process.env.PA_SOCKET);
  client.pipe(remote);remote.pipe(client);
  client.on('error',()=>remote.destroy());remote.on('error',()=>client.destroy());
  client.on('close',()=>remote.destroy());remote.on('close',()=>client.destroy());
 }).listen(local);
}
`, { mode: 0o755 });
  savePersonalConfig(userData, { host: "test-personal", controlDir: "/var/lib/ruukoto/control" });
  const env = { ...previous, PATH: `${temporary}:${previous.PATH}`, RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_CODE_CONTROL_DIR: controlDir, RUUKOTO_CODE_DATA_DIR: code.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: code.dirs.agentDir, PA_SOCKET: personal.runtime.socketPath(), PA_TOKEN_FILE: path.join(personal.runtime.controlDir(), "owner.token") };
  const updates: Record<DesktopTarget, DesktopUpdate[]> = { code: [], personal: [] };
  const host = new DesktopHost(path.resolve(import.meta.dirname, ".."), userData, { publish: (target, update) => updates[target].push(update), focused: () => true, notice() {}, badge() {} }, async () => ({ env, node: process.execPath }));
  const online = (target: DesktopTarget) => updates[target].filter(update => update.type === "state").at(-1)?.state === "online";
  try {
    const codeSession = (await code.runtime.openWorkspace({ cwd: code.work[0] })).session.id;
    const main = personal.runtime.snapshot().mainSessionId!;
    host.subscribe("code"); host.subscribe("personal");
    await waitFor("两个真实后台在线", () => online("code") && online("personal"));
    const selected = path.join(temporary, "selected.txt"); fs.writeFileSync(selected, "按目标上传");
    for (const [target, sessionId, runtime] of [["code", codeSession, code.runtime], ["personal", main, personal.runtime]] as const) {
      const [attachment] = await host.pickAttachments(sessionId, async () => [selected], undefined, target);
      assert.equal(runtime.attachments.prepare(sessionId, [attachment])[0].bytes.toString(), "按目标上传");
      const pending = await host.request(target, "desktop_pending_read", { request_id: "missing" });
      assert.equal(pending.ok, false);
      if (!pending.ok) assert.equal(pending.error.code, "not_restorable");
      if (target === "personal") {
        const submitted = await host.request("personal", "submit", { session_id: main, request_id: "main-with-file", input: "查看附件", attachments: [attachment], model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
        assert.equal(submitted.ok && typeof submitted.value === "object" && submitted.value !== null && "kind" in submitted.value && submitted.value.kind, "accepted");
        const task = personal.runtime.store.listTasksBySession(main).find(item => item.requestId === "main-with-file")!;
        assert.equal(personal.runtime.store.taskAttachments(task.id)[0].id, attachment.id);
      }
    }
    const original = host.attachmentInstance("personal");
    await assert.rejects(host.pickAttachments(main, async () => {
      await host.request("personal", "reconnect", {});
      await waitFor("同 PA 数据实例重连", () => online("personal"));
      return ["/must-not-read"];
    }, original, "personal"), { code: "attachment_instance_changed" });
    assert.notEqual(host.attachmentInstance("personal"), original);
    let picked = false;
    assert.throws(() => host.pickAttachments(main, async () => { picked = true; return [selected]; }, original, "personal"), { code: "attachment_instance_changed" });
    assert.equal(picked, false);
    const codeSelection = host.attachmentInstance();
    await host.request("code", "reconnect", {});
    await waitFor("同 Code 数据实例重连", () => online("code"));
    assert.notEqual(host.attachmentInstance(), codeSelection);
    assert.throws(() => host.pickAttachments(codeSession, async () => assert.fail("旧连接不能打开选择器"), codeSelection), { code: "attachment_instance_changed" });
    assert.throws(() => host.attachmentInstance("other"), { code: "target_unavailable" });
    assert.equal(online("code"), true);
    const before = updates.personal.filter(update => update.type === "snapshot").at(-1);
    assert.equal(before?.type === "snapshot" && before.result.snapshot.instanceId, personal.runtime.snapshot().instanceId);
  } finally {
    await host.close(); adoptEnvironment(previous);
    await personal.shutdown(); await code.shutdown();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
