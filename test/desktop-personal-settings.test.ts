import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { PersonalSettingsController, personalMachineCommand } from "../apps/desktop/src/main/personal-settings-controller.ts";
import { PERSONAL_PROGRAMS, loadPersonalConfig, savePersonalConfig, loadPersonalManagementConfig, savePersonalManagementConfig, validatePersonalManagementConfig, type PersonalManagementConfig } from "../apps/desktop/src/main/personal-config.ts";
import { PersonalManagementState } from "../apps/desktop/src/renderer/personal-management-state.ts";
import { SshProcess } from "../apps/desktop/src/main/personal-ssh.ts";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import type { DesktopResult } from "../apps/desktop/src/shared/bridge.ts";

const profile = { directory: "/remote/profile", id: "sha256:" + "a".repeat(64) };
const oldRevision = "sha256:" + "b".repeat(64), newRevision = "sha256:" + "c".repeat(64);
const config: PersonalManagementConfig = { host: "pa", profileDir: profile.directory, program: PERSONAL_PROGRAMS[0], lifecycle: "systemd" };
const mutation = () => ({ v: 1, op: "config.save", profile, expectedRevision: oldRevision, target: "model", value: { apiKeyEnv: "NEW_KEY", model: "draft-private-value" } });
type Scenario = { online: boolean; token: string; revision: string; fault?: string; writable?: boolean; blockers?: unknown[]; credential?: string; product?: string; v?: number; identity?: string; reject?: string };
async function harness(patch: Partial<Scenario> = {}, timeoutMs = 3000) {
  const dir = fs.mkdtempSync("/tmp/rk-settings-"), scenarioFile = path.join(dir, "scenario.json"), log = path.join(dir, "calls.jsonl"), childrenFile = path.join(dir, "children");
  const initial: Scenario = { online: true, token: "1".repeat(64), revision: oldRevision, ...patch };
  fs.writeFileSync(scenarioFile, JSON.stringify(initial));
  const scenario = (): Scenario => JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
  const write = (patch: Partial<Scenario>) => fs.writeFileSync(scenarioFile, JSON.stringify({ ...scenario(), ...patch }));
  const snapshot = () => {
    const s = scenario();
    return { product: "ruukoto", profile: { ...profile, id: s.identity ?? profile.id }, online: s.online, revisions: { model: s.revision, skills: oldRevision, mcp: oldRevision }, blockers: s.blockers ?? [], model: { config: { apiKeyEnv: "KEY" }, credential: { state: s.credential ?? (s.online ? "available" : "unverified"), reference: "KEY" } }, lifecycle: { managedDevelopment: false } };
  };
  const auth: string[] = [], onlineRequests: Record<string, unknown>[] = [];
  const remote = path.join(dir, "remote.sock");
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      auth.push(String(req.headers.authorization));
      const request = JSON.parse(body), s = scenario();
      onlineRequests.push(request);
      if (req.headers.authorization !== `Bearer ${s.token}`) { res.end(JSON.stringify({ v: 1, ok: false, code: "unauthorized", message: "invalid " + s.token })); return; }
      if (s.fault === "http-control-disconnect" && request.op === "mcp.cua-control") { req.destroy(); return; }
      if (s.fault === "http-control-large" && request.op === "mcp.cua-control") { res.end(JSON.stringify({ v: 1, ok: true, result: { product: "ruukoto", profile, paused: true, padding: "x".repeat(300000) } })); return; }
      if (s.fault === "http-secret") { res.end(JSON.stringify({ v: 1, ok: false, code: "test_secret", message: s.token })); return; }
      if (request.op === "mcp.cua-control") { res.end(JSON.stringify({ v: 1, ok: true, result: { product: "ruukoto", profile, paused: request.action === "pause", busy: false, operations: [] } })); return; }
      const result = request.op === "config.preflight" ? { product: "ruukoto", profile, blockers: s.blockers ?? [], credential: { state: s.credential ?? "available" } } : snapshot();
      res.end(JSON.stringify({ v: 1, ok: true, result }));
    });
  });
  server.listen(remote); await once(server, "listening");
  const executable = path.join(dir, "ssh");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs'), net = require('node:net');
const args = process.argv.slice(2), file = process.env.SCENARIO;
fs.appendFileSync(process.env.CHILDREN, process.pid+'\\n');
const read = () => JSON.parse(fs.readFileSync(file,'utf8'));
const write = value => fs.writeFileSync(file,JSON.stringify(value));
if(args.includes('-N')) {
  const local = args[args.indexOf('-L')+1].split(':')[0];
  fs.rmSync(local,{force:true});
  net.createServer(client=>{const remote=net.connect(process.env.REMOTE);client.pipe(remote);remote.pipe(client);client.on('error',()=>remote.destroy());remote.on('error',()=>client.destroy());client.on('close',()=>remote.destroy());remote.on('close',()=>client.destroy());}).listen(local);
} else if(args.at(-1).includes('cat --')) {
  process.stdout.write(read().token+'\\n');
} else {
  let input=''; process.stdin.on('data',chunk=>input+=chunk); process.stdin.on('end',()=>{
    const req=JSON.parse(input), s=read(), maintenance=args.at(-1).endsWith(' maintenance');
    fs.appendFileSync(process.env.LOG,JSON.stringify({entry:maintenance?'maintenance':'settings',op:req.op,limit:req.limit,command:args.at(-1),hasJsonInCommand:args.at(-1).includes('draft-private-value')})+'\\n');
    const identity={directory:'/remote/profile',id:s.identity||'${profile.id}'};
    let result;
    if(maintenance) {
      if(req.op==='start'&&s.fault==='start-reject'){delete s.fault;write(s);process.stdout.write(JSON.stringify({v:1,product:'ruukoto',ok:false,code:'maintenance_start_unverified',message:'原服务启动失败，请核实已保存配置。'})+'\\n');return;}
      if(req.op==='stop')s.online=false;
      if(req.op==='start'){s.online=true;s.token='2'.repeat(64);}
      write(s);
      result={profile:identity,online:s.online,writable:s.writable!==false,code:'test_status',reason:s.writable===false?'只读：管理员需配置精确授权与 SendSIGKILL=no。':'服务身份与部署已核实。',lifecycle:{kind:req.lifecycle,state:s.online?'running':'stopped',managedDevelopment:false,originalEnvironment:'unverified'}};
    } else if(req.op==='config.save'||req.op==='skills.set-enabled') {
      if(s.reject){process.stdout.write(JSON.stringify({v:1,product:'ruukoto',ok:false,code:s.reject,message:'配置未保存，请恢复原后台并比较当前配置。'})+'\\n');return;}
      s.revision='${newRevision}';write(s);result={product:'ruukoto',profile:identity,saved:true,revision:s.revision};
      if(s.fault==='save-journal'){
        const dir=process.env.USER_DATA+'/pending/personal-settings';const file=fs.readdirSync(dir).find(name=>name.endsWith('.json'));fs.mkdirSync(dir+'/'+file+'.tmp');delete s.fault;write(s);
      }
      if(s.fault==='save-internal'){delete s.fault;write(s);process.stdout.write(JSON.stringify({v:1,product:'ruukoto',ok:false,code:'settings_internal',message:'结果无法核实。'})+'\\n');return;}
    } else result={product:'ruukoto',profile:identity,online:s.online,revisions:{model:s.revision,skills:'${oldRevision}',mcp:'${oldRevision}'},blockers:s.blockers||[],model:{config:{apiKeyEnv:'KEY'},credential:{state:s.online?'available':'unverified',reference:'KEY'}},lifecycle:{managedDevelopment:false}};
    const stage=maintenance?req.op:req.op==='config.save'?'save':'read';
    if(s.fault===stage+'-disconnect'){delete s.fault;write(s);process.exit(255);}
    if(s.fault===stage+'-hang'){setInterval(()=>{},1000);return;}
    if(s.fault==='large'){process.stdout.write('x'.repeat(300000));return;}
    process.stdout.write(JSON.stringify({v:s.v||1,product:s.product||'ruukoto',ok:true,result})+'\\n');
  });
}
`, { mode: 0o755 });
  const userData = path.join(dir, "app");
  const env = { ...process.env, SCENARIO: scenarioFile, LOG: log, REMOTE: remote, CHILDREN: childrenFile, USER_DATA: userData };
  const create = () => new PersonalSettingsController(config, userData, env, { ssh: executable, timeoutMs });
  let controller = create();
  const calls = (): { entry: string; op: string; limit?: number; command: string; hasJsonInCommand: boolean }[] => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { dir, userData, controller, auth, onlineRequests, calls, scenario, write, async reopen() { await controller.close(); controller = create(); this.controller = controller; return controller; }, async close() {
    await controller.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const pid of fs.existsSync(childrenFile) ? fs.readFileSync(childrenFile, "utf8").trim().split("\n").map(Number) : []) assert.throws(() => process.kill(pid, 0), "所有自有 SSH 子进程必须回收");
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test("管理前检与探测只读取一项配置，合法大 MCP 列表可继续按页查询", async () => {
  const h = await harness();
  try {
    await h.controller.probe(); await h.controller.read();
    assert.ok(h.calls().filter(call => call.op === "settings.read").every(call => call.limit === 1));
    assert.ok(h.onlineRequests.length > 0); assert.ok(h.onlineRequests.filter(call => call.op === "settings.read").every(call => call.limit === 1));
  } finally { await h.close(); }
});

test("新管理配置独立存储；主机参数拒绝注入，档案路径经 shell 转义", () => {
  const dir = fs.mkdtempSync("/tmp/rk-config-");
  try {
    assert.equal(loadPersonalManagementConfig(dir), null);
    savePersonalConfig(dir, { host: "legacy", controlDir: "/old" });
    assert.deepEqual(savePersonalManagementConfig(dir, config), config);
    assert.deepEqual(loadPersonalConfig(dir), { host: "legacy", controlDir: "/old" });
    for (const host of ["-x", "a b", "a;whoami", "a\nb"]) assert.throws(() => validatePersonalManagementConfig({ ...config, host }, dir));
    for (const profileDir of ["a", "/a:123", "/a\nb", "/a/../b", "/a/"]) assert.throws(() => validatePersonalManagementConfig({ ...config, profileDir }, dir));
    assert.throws(() => validatePersonalManagementConfig({ ...config, program: "/bin/sh -c evil" }, dir));
    assert.throws(() => validatePersonalManagementConfig({ ...config, token: "secret" }, dir));
    const marker = path.join(dir, "injected"), program = path.join(dir, "capture");
    fs.writeFileSync(program, '#!/bin/sh\nprintf "%s" "$RUUKOTO_PERSONAL_DIR"', { mode: 0o755 });
    const profileDir = `a'; touch ${marker}; #`;
    const result = spawnSync("/bin/sh", ["-c", personalMachineCommand({ ...config, profileDir, program }, "settings")], { encoding: "utf8" });
    assert.equal(result.stdout, profileDir); assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.statSync(path.join(dir, "personal-settings.json")).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("SSH 有界 JSON 保留跨 stdout chunk 的多字节字符", async () => {
  const reader = new SshProcess(process.execPath, ["-e", "const b=Buffer.from('中文');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)"], process.env, true);
  assert.equal((await reader.done).stdout, "中文");
});

test("连接先核已有档案的维护身份，失败时不调用可能初始化目录的 settings 入口", async () => {
  for (const entry of ["read", "probe"] as const) {
    const h = await harness({ fault: "inspect-disconnect" });
    try {
      await assert.rejects(h.controller[entry]());
      assert.deepEqual(h.calls().map(call => [call.entry, call.op]), [["maintenance", "inspect"]]);
    } finally { await h.close(); }
  }
});

test("保存后内部错误不冒充明确未保存", async () => {
  const h = await harness({ fault: "save-internal" });
  try { await assert.rejects(h.controller.apply(mutation()), { code: "settings_internal", outcome: "unknown" }); const view = await h.controller.read(); assert.equal(view.saved, null); assert.equal(view.settings.revisions.model, newRevision); assert.equal(view.pending?.saveAttempted, true); }
  finally { await h.close(); }
});

test("已取得保存回执后本机记录失败仍报告已保存，且停止后续启动", async () => {
  const h = await harness({ fault: "save-journal" });
  try {
    await assert.rejects(h.controller.apply(mutation()), { code: "maintenance_saved_start_unverified", outcome: "unknown" });
    const view = await h.controller.read(); assert.equal(view.saved, true); assert.equal(view.pending?.savedRevision, newRevision);
    assert.equal(h.calls().some(call => call.op === "start"), false);
  } finally { await h.close(); }
});

test("Host 在原维护待核实时保留连接，退出中止维护而不保存或启动", async () => {
  const h = await harness({ fault: "stop-hang" });
  let host: DesktopHost | undefined;
  try {
    savePersonalManagementConfig(h.userData, config);
    const applying = h.controller.apply(mutation());
    const rejected = assert.rejects(applying, { code: "management_changed", outcome: "unknown" });
    while (!h.calls().some(call => call.op === "stop")) await new Promise(resolve => setTimeout(resolve, 10));
    await h.controller.close(); await rejected;
    host = new DesktopHost(process.cwd(), h.userData, { publish() {}, focused: () => false, notice() {}, badge() {} }, async () => { throw new Error("本用例不创建后台"); });
    const result = await host.request("personal", "desktop_personal_management_config_save", { ...config, host: "other" });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "maintenance_pending");
    assert.deepEqual(loadPersonalManagementConfig(h.userData), config);
    assert.equal(h.calls().some(call => call.op === "start" || call.op === "config.save"), false);
  } finally { await host?.close(); await h.close(); }
});

for (const patch of [{ v: 2 }, { product: "ruukoto-code" }, { identity: "sha256:" + "e".repeat(64) }]) {
  test(`拒绝旧协议、产品或档案变化 ${JSON.stringify(patch)}`, async () => {
    const h = await harness();
    try { await h.controller.read(); h.write(patch); await assert.rejects(h.controller.read(), { code: patch.identity ? "settings_profile_changed" : "personal_protocol" }); assert.equal(h.calls().filter(call => ["stop", "start", "config.save"].includes(call.op)).length, 0); }
    finally { await h.close(); }
  });
}

test("HTTP 每次读取轮换 token，错误脱敏，模型请求 JSON 不进入命令参数", async () => {
  const h = await harness();
  try {
    await h.controller.read(); h.write({ token: "3".repeat(64) }); await h.controller.read();
    assert.ok(h.auth.includes("Bearer " + "1".repeat(64))); assert.ok(h.auth.includes("Bearer " + "3".repeat(64)));
    h.write({ fault: "http-secret" }); await assert.rejects(h.controller.read(), error => error instanceof Error && !error.message.includes("3".repeat(64)) && error.message.includes("隐藏"));
    h.write({ fault: undefined });
    const result = await h.controller.apply(mutation());
    assert.equal(result.saved, true); assert.equal(result.pending, null); assert.equal(result.settings.online, true);
    assert.ok(h.calls().every(call => !call.hasJsonInCommand));
    assert.ok(!JSON.stringify(fs.readdirSync(h.userData)).includes("token"));
  } finally { await h.close(); }
});

test("未决、只读或实际凭据不可用在停止前拒绝；请求与响应限额有效", async () => {
  for (const patch of [{ blockers: [{ kind: "pending-work" }] }, { writable: false }, { credential: "missing" }]) {
    const h = await harness(patch);
    try { await assert.rejects(h.controller.apply(mutation())); assert.equal(h.calls().filter(call => call.op === "stop").length, 0); }
    finally { await h.close(); }
  }
  const h = await harness();
  try {
    await assert.rejects(h.controller.apply({ ...mutation(), value: "x".repeat(128 * 1024) }), { code: "settings_request_large" });
    await assert.rejects(h.controller.request({ v: 1, op: "config.save" }));
    h.write({ fault: "large" }); await assert.rejects(h.controller.read(), { code: "management_transport" });
    assert.equal(h.calls().filter(call => call.op === "stop").length, 0);
  } finally { await h.close(); }
});

for (const stage of ["stop", "save", "start"]) {
  test(`${stage} 阶段断线保留原操作，重开只查询，恢复不重发保存`, async () => {
    const h = await harness({ fault: stage + "-disconnect" });
    try {
      if (stage === "start") { const result = await h.controller.apply(mutation()); assert.equal(result.saved, true); assert.ok(result.pending); }
      else await assert.rejects(h.controller.apply(mutation()));
      const recordFile = path.join(h.userData, "pending", "personal-settings", fs.readdirSync(path.join(h.userData, "pending", "personal-settings"))[0]);
      const record = fs.readFileSync(recordFile, "utf8"); assert.ok(!record.includes("draft-private-value")); assert.ok(!record.includes("1".repeat(64)));
      const before = h.calls().filter(call => ["stop", "start", "config.save"].includes(call.op));
      const controller = await h.reopen();
      const view = await controller.read();
      assert.equal(view.saved, stage === "start" ? true : stage === "save" ? null : false);
      assert.deepEqual(h.calls().filter(call => ["stop", "start", "config.save"].includes(call.op)), before);
      await assert.rejects(controller.apply(mutation()), { code: "maintenance_pending" });
      if (!view.settings.online) assert.equal((await controller.restore()).settings.online, true);
      assert.equal(h.calls().filter(call => call.op === "config.save").length, stage === "stop" ? 0 : 1);
      assert.equal((await controller.finish()).pending, null);
    } finally { await h.close(); }
  });
}

for (const rejection of ["settings_pending", "skills_revision_conflict"]) test(`停止后保存明确拒绝 ${rejection} 保留原配置，并可显式恢复`, async () => {
  const h = await harness({ reject: rejection });
  try {
    const request = rejection === "skills_revision_conflict" ? { v: 1, op: "skills.set-enabled", profile, expectedRevision: oldRevision, id: "00000000-0000-4000-8000-000000000001", enabled: false } : mutation();
    await assert.rejects(h.controller.apply(request), { code: rejection, outcome: "rejected" });
    const view = await h.controller.read(); assert.equal(view.saved, false); assert.equal(view.settings.online, false); assert.equal(view.settings.revisions.model, oldRevision);
    assert.equal(view.pending?.rejected, rejection);
    assert.equal((await h.controller.restore()).settings.online, true);
  } finally { await h.close(); }
});

test("保存成功但原服务启动失败保留已保存事实，显式恢复只启动一次不重存", async () => {
  const h = await harness({ fault: "start-reject" });
  try {
    const result = await h.controller.apply(mutation());
    assert.equal(result.saved, true); assert.equal(result.settings.online, false); assert.equal(result.pending?.savedRevision, newRevision);
    assert.match(result.message, /已保存/);
    assert.equal((await h.controller.restore()).settings.online, true);
    assert.equal(h.calls().filter(call => call.op === "config.save").length, 1);
    assert.equal(h.calls().filter(call => call.op === "start").length, 2);
  } finally { await h.close(); }
});

test("停止超时或退出只回收自有 SSH，不继续保存、不自动启动", async () => {
  const h = await harness({ fault: "stop-hang" }, 1500);
  try {
    await assert.rejects(h.controller.apply(mutation()), { code: "management_timeout" });
    assert.equal(h.calls().some(call => call.op === "config.save" || call.op === "start"), false);
    h.write({ fault: undefined }); assert.equal((await h.controller.read()).saved, false);
  } finally { await h.close(); }
});

test("向导丢答后只核实本机配置，关闭与改连接使迟到结果失效", async () => {
  let resolve!: (value: DesktopResult<unknown>) => void;
  const calls: string[] = [];
  const state = new PersonalManagementState({ request: async (_target, op) => { calls.push(op); if (op.endsWith("config_read")) return { ok: true, value: config }; return new Promise(done => { resolve = done; }); } }, () => {});
  await state.read(); state.edit("host", "changed");
  const saving = state.save(); state.invalidate(); resolve({ ok: true, value: { ...config, host: "changed" } }); await saving;
  assert.equal(state.phase, "unknown"); assert.equal(state.draft.host, "changed");
  await state.read(); assert.equal(state.phase, "conflict"); assert.equal(state.draft.host, "changed");
  assert.equal(calls.filter(op => op.endsWith("config_save")).length, 1);
});

test("Personal Cua 在线控制沿受保护后台执行，不因未决事项进入停存启，丢答不伪装未发送", async () => {
  const h = await harness({ blockers: [{ kind: "mcp" }], writable: false });
  try {
    await h.controller.read();
    const before = h.calls().length;
    const value = { v: 1, op: "mcp.cua-control", profile, expectedRevision: oldRevision, action: "pause" };
    const result = await h.controller.request(value);
    assert.equal(result.paused, true); assert.equal(h.calls().length, before); assert.equal(h.controller.hasPendingOperation(), false);
    assert.equal(h.onlineRequests.filter(request => request.op === "mcp.cua-control").length, 1);
    h.write({ fault: "http-control-disconnect" });
    await assert.rejects(h.controller.request({ ...value, action: "resume" }), { code: "management_http", outcome: "unknown" });
    assert.equal(h.onlineRequests.filter(request => request.op === "mcp.cua-control").length, 2);
    assert.equal(h.calls().length, before);
  } finally { await h.close(); }
});

test("Personal Cua 控制已执行后应答超限仍属结果未知", async () => {
  const h = await harness();
  try {
    await h.controller.read(); h.write({ fault: "http-control-large" });
    await assert.rejects(h.controller.request({ v: 1, op: "mcp.cua-control", profile, expectedRevision: oldRevision, action: "pause" }), { code: "settings_response_large", outcome: "unknown" });
    assert.equal(h.onlineRequests.filter(request => request.op === "mcp.cua-control").length, 1);
  } finally { await h.close(); }
});

test("Personal Cua 控制已执行后关闭管理连接不冒充未发送", async t => {
  const h = await harness(); let closing: Promise<void> | undefined;
  try {
    await h.controller.read();
    const emit = http.IncomingMessage.prototype.emit; let armed = true;
    t.mock.method(http.IncomingMessage.prototype, "emit", function (this: http.IncomingMessage, event: string | symbol, ...args: unknown[]) {
      if (armed && event === "end" && typeof this.statusCode === "number") { armed = false; closing = h.controller.close(); }
      return emit.call(this, event, ...args);
    });
    await assert.rejects(h.controller.request({ v: 1, op: "mcp.cua-control", profile, expectedRevision: oldRevision, action: "pause" }), { code: "management_changed", outcome: "unknown" });
    assert.equal(h.onlineRequests.filter(request => request.op === "mcp.cua-control").length, 1);
  } finally { await closing; await h.close(); }
});
