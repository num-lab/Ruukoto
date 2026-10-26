import { test } from "node:test";
import assert from "node:assert/strict";
import type { Terminal } from "@earendil-works/pi-tui";
import { ControlClient } from "@ruukoto/control/client.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { executeApprovedHttpRequest } from "@ruukoto/agent/execution/approved-ops.ts";
import { getProjectJevConfig, jevConfigKey, jevCredentialHost, JEV_HOST, type JevConfig } from "@ruukoto/agent/jev-config.ts";
import { runConfigTui } from "@ruukoto/tui/config-tui/index.ts";
import { createProjectSession, startTestRuntime, waitFor, type TestRuntime } from "./helpers/testkit.ts";
import { legacyGroupArchive } from "./helpers/legacy-group-archive.ts";

const quiet = async () => ({ kind: "text" as const, text: "ok" });
const secret = "jev-test-secret-never-shown";
const binding = { name: "jev-test", host: JEV_HOST, header: "authorization", purpose: "jev_context", secret };

async function setConfig(t: TestRuntime, projectId: string, config: Partial<JevConfig> = {}, expectedVersion = 0): Promise<JevConfig> {
  return t.client.request<JevConfig>("set_project_jev", {
    project_id: projectId, enabled: true, credential: binding.name, expected_version: expectedVersion, ...config,
  });
}

test("Jev 配置：默认关闭、拥有者认证、CAS、持久记录与凭据撤销后的停用", async () => {
  const t = await startTestRuntime("jev-config", quiet);
  const unauthenticated = await ControlClient.connect(t.runtime.socketPath());
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!);
    assert.deepEqual(await t.client.request("get_project_jev", { project_id: projectId }), { enabled: false, credential: null, configVersion: 0 });
    await assert.rejects(unauthenticated.request("set_project_jev", { project_id: projectId, enabled: true, credential: binding.name, expected_version: 0 }), /未认证/);
    await t.client.request("add_credential", binding);
    const configured = await setConfig(t, projectId);
    assert.deepEqual(configured, { enabled: true, credential: binding.name, configVersion: 1 });
    assert.deepEqual(getProjectJevConfig(t.runtime.store, projectId), configured);
    assert.deepEqual(JSON.parse(t.runtime.store.getMetaValue(jevConfigKey(projectId))!), configured);
    await assert.rejects(setConfig(t, projectId, { enabled: false }), /版本冲突/);
    await assert.rejects(t.client.request("set_project_jev", { project_id: projectId, enabled: false, credential: null }), /expected_version/);
    await t.client.request("remove_credential", { name: binding.name });
    const disabled = await setConfig(t, projectId, { enabled: false }, 1);
    assert.equal(disabled.enabled, false, "凭据已删除时仍必须能够关闭实验");
    assert.equal(disabled.configVersion, 2);
    await assert.rejects(setConfig(t, projectId, {}, 2), /凭据/);
    const events = t.runtime.store.getEventsAfter(0).filter((event) => event.body.type === "project.jev_changed");
    assert.equal(events.length, 2, "失败的配置写入不得产生成功事件");
    assert.ok(!JSON.stringify({ configured, events }).includes(secret));
  } finally {
    unauthenticated.close();
    await t.shutdown();
  }
});

test("Jev 凭据：保存即隔离通用 HTTP，绑定项目后拒绝跨项目与范围扩大", async () => {
  const t = await startTestRuntime("jev-credentials", quiet);
  try {
    const first = await createProjectSession(t.client, t.work[0]!);
    const second = await createProjectSession(t.client, t.work[1]!);
    await t.client.request("add_credential", binding);
    assert.deepEqual(t.runtime.credentials.get(binding.name)?.scope, { operations: ["jev_context"] });
    const denied = await executeApprovedHttpRequest({ method: "POST", url: `https://${JEV_HOST}/v1/systemone`, headers: {}, credentialName: binding.name }, t.runtime.credentials);
    assert.equal(denied.ok, false);
    assert.match(denied.message, /通用 HTTP 请求不得使用/);
    await setConfig(t, first.projectId);
    assert.equal(t.runtime.credentials.getForUse(binding.name, { projectId: second.projectId, operation: "jev_context" }), null);
    assert.equal(t.runtime.credentials.getForUse(binding.name, { projectId: first.projectId, operation: "mcp" }), null);
    await assert.rejects(setConfig(t, second.projectId), /其他项目/);
    await t.client.request("add_credential", { ...binding, secret: "rotated-test-secret" });
    assert.deepEqual(t.runtime.credentials.get(binding.name)?.scope, { projectId: first.projectId, operations: ["jev_context"] }, "轮换秘密值不能丢失项目范围");
    await assert.rejects(t.client.request("add_credential", { ...binding, host: "other.example" }), /host=/);
    t.runtime.credentials.upsert({ ...binding, name: "scoped-elsewhere", scope: { operations: ["mcp"] } });
    await assert.rejects(t.client.request("add_credential", { ...binding, name: "scoped-elsewhere" }), /其他使用范围/);
  } finally {
    await t.shutdown();
  }
});

test("Jev 配置：拒绝错误凭据、QQ/chat、坏字段与损坏持久配置", async () => {
  const t = await startTestRuntime("jev-boundaries", quiet);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await t.client.request("add_credential", binding);
    for (const patch of [
      { host: "other.example" }, { header: "x-api-key" }, { purpose: "mcp" }, { secret: "" },
      { scope: { operations: ["mcp"] } }, { scope: { operations: [] } }, { scope: { repoId: 42 } },
    ]) {
      t.runtime.credentials.upsert({ ...binding, name: "invalid", ...patch });
      await assert.rejects(setConfig(t, projectId, { credential: "invalid" }), /凭据/);
    }
    await assert.rejects(setConfig(t, projectId, { credential: null }), /选择服务凭据/);
    await assert.rejects(setConfig(t, "missing-project"), /项目不存在/);
    // 旧安装的 chat 角色行由播种助手写入（核心群聊已退役，issue 20）
    const chatRole = legacyGroupArchive({ store: t.runtime.store, qq: t.runtime.qqStore, workRoot: t.dirs.root }).seedChatRole();
    await assert.rejects(setConfig(t, chatRole.projectId), /QQ 群聊与 chat/);
    t.runtime.store.db.prepare("UPDATE sessions SET kind = 'qq_group' WHERE id = ?").run(sessionId);
    await assert.rejects(setConfig(t, projectId), /QQ 群聊与 chat/);
    for (const config of [
      "{", "null", "[]", JSON.stringify({ enabled: true, credential: null, configVersion: 1 }),
      JSON.stringify({ enabled: "true", credential: binding.name, configVersion: 1 }),
      JSON.stringify({ enabled: false, credential: binding.name, configVersion: -1 }),
      JSON.stringify({ enabled: false, credential: binding.name, configVersion: 1, endpoint: "https://other.example" }),
    ]) {
      t.runtime.store.setMetaValue(jevConfigKey(projectId), config);
      assert.throws(() => getProjectJevConfig(t.runtime.store, projectId), /配置损坏/);
    }
  } finally {
    await t.shutdown();
  }
});

test("Jev 测试目标：只允许回环覆盖，并按实际目标验证凭据主机", async () => {
  for (const url of ["https://other.example", "http://127.0.0.1.example", "http://user:pass@localhost", "file:///tmp/jev", "http://localhost?redirect=1"]) {
    assert.throws(() => jevCredentialHost(url), /回环/);
  }
  assert.equal(jevCredentialHost("http://[::1]:1234"), "[::1]:1234");
  const t = await startTestRuntime("jev-loopback-config", quiet, { config: { jev: { baseUrl: "http://127.0.0.1:1234" } } });
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!);
    await t.client.request("add_credential", { ...binding, host: "127.0.0.1:1234" });
    assert.equal((await setConfig(t, projectId)).enabled, true);
  } finally {
    await t.shutdown();
  }
});

class FakeTerminal implements Terminal {
  columns = 120;
  rows = 35;
  readonly kittyProtocolActive = false;
  output = "";
  private input: ((data: string) => void) | null = null;
  start(input: (data: string) => void): void { this.input = input; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
  send(...keys: string[]): void { for (const key of keys) this.input?.(key); }
}

test("Jev 配置中心：选择凭据、披露数据发送、处理并发冲突并启停", async () => {
  const t = await startTestRuntime("jev-tui", quiet);
  const terminal = new FakeTerminal();
  const down = "\x1b[B", up = "\x1b[A", enter = "\r";
  let done: Promise<number> | undefined;
  const see = (text: string) => waitFor(text, () => terminal.output.includes(text));
  try {
    const projectId = t.runtime.store.getAgentRole("main")!.projectId;
    await t.client.request("add_credential", binding);
    done = runConfigTui({ terminal, agentDir: t.dirs.agentDir, connect: { socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! } });
    await see("配置分区");
    terminal.send(down, enter);
    await see("指令 ");
    const index = t.runtime.store.listProjects().findIndex((project) => project.id === projectId);
    terminal.send(...Array.from({ length: index }, () => down), enter);
    await see("Jev 上下文筛选实验");
    terminal.send(down, enter);
    await see("普通账号的零保留未获保证");
    terminal.send(down, enter);
    await see("Jev 服务凭据");
    terminal.send(down, enter);
    await waitFor("凭据已绑定", () => t.runtime.getProjectJev(projectId).configVersion === 1);
    await see("Jev 实验已关闭");
    terminal.send(up, enter);
    await see("启用 Jev 实验？");
    await setConfig(t, projectId, { enabled: false }, 1);
    terminal.send(enter);
    await see("配置已被其他客户端修改，已重新加载");
    assert.equal(t.runtime.getProjectJev(projectId).enabled, false, "旧确认不能覆盖其他客户端的新配置");
    terminal.output = "";
    terminal.send(enter);
    await see("启用 Jev 实验？");
    terminal.send(enter);
    await waitFor("Jev 已启用", () => t.runtime.getProjectJev(projectId).enabled);
    await see("Jev 实验已启用，从下一任务生效");
    terminal.send(enter);
    await waitFor("Jev 已关闭", () => !t.runtime.getProjectJev(projectId).enabled);
    assert.ok(!terminal.output.includes(secret));
  } finally {
    terminal.send("\x03");
    if (done) assert.equal(await done, 0);
    await t.shutdown();
  }
});
