import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchMacosExecution, stopMacosExecution, type MacosExecutionRef } from "@ruukoto/agent/execution/native-macos-identity.ts";
import { ExecutionError, type LaunchedUnit, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import type { PreparedNativeLaunch } from "@ruukoto/agent/execution/native.ts";

const helper = fileURLToPath(new URL("../worker/native-macos-supervisor", import.meta.url));
const available = process.platform === "darwin" && fs.existsSync(helper);
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error("持久监督器夹具等待超时"); await delay(10); }
}

function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/rk-macos-identity-"));
  const workspace = path.join(directory, "work"), tempDir = path.join(directory, "temp"), evidence = path.join(directory, "evidence");
  for (const target of [workspace, tempDir, evidence]) fs.mkdirSync(target, { mode: 0o700 });
  const workerPath = path.join(workspace, "fixture.mjs");
  const release = path.join(workspace, "release");
  fs.writeFileSync(workerPath, `import fs from 'node:fs';import cp from 'node:child_process';const root=${JSON.stringify(workspace)};const role=process.argv[2]??'root';for(const s of[process.stdout,process.stderr])s.on('error',e=>{if(e.code!=='EPIPE')throw e;});if(role==='root'){fs.appendFileSync(root+'/launches','launch\\n');cp.spawn(process.execPath,[import.meta.filename,'descendant'],{detached:true,stdio:['ignore','inherit','inherit']});}process.on('SIGTERM',()=>fs.appendFileSync(root+'/'+role+'.term','TERM'));fs.writeFileSync(root+'/'+role+'.ready',JSON.stringify({pid:process.pid,ppid:process.ppid}));const until=Date.now()+20000;const timer=setInterval(()=>{if(fs.existsSync(root+'/release')||Date.now()>until){clearInterval(timer);fs.writeFileSync(root+'/'+role+'.finished','finished');process.exit(0);}if(role==='descendant'){fs.appendFileSync(root+'/beats','beat\\n');process.stdout.write('out\\n');process.stderr.write('err\\n');}},100);`);
  const ref: MacosExecutionRef = { executionId: `native_${randomBytes(12).toString("hex")}` };
  const input: PreparedNativeLaunch = { workspace, tempDir, workerPath, nodePath: fs.realpathSync(process.execPath), runtimeReadRoots: [], mounts: [], toolAliases: [], env: {} };
  const spec: LaunchSpec = { taskId: "macos-durable-check", workspace, mode: "full_access", grantedPaths: [] };
  const fingerprint = createHash("sha256").update(JSON.stringify({ input, spec })).digest("hex");
  const claimDir = path.join(evidence, ref.executionId);
  const ready = (): boolean => fs.existsSync(path.join(workspace, "descendant.ready")) && fs.existsSync(path.join(workspace, "beats"));
  const read = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(claimDir, name), "utf8"));
  const launched = (): number => fs.existsSync(path.join(workspace, "launches")) ? fs.readFileSync(path.join(workspace, "launches"), "utf8").trim().split("\n").length : 0;
  const releaseFixture = (): void => { fs.writeFileSync(release, "release"); };
  return { directory, workspace, evidence, input, spec, ref, fingerprint, claimDir, ready, read, launched, releaseFixture };
}

async function cleanup(f: ReturnType<typeof fixture>, unit?: LaunchedUnit): Promise<void> {
  f.releaseFixture();
  if (unit) {
    unit.stdout.resume?.(); unit.stderr.resume?.();
    assert.equal(await unit.entry.stop(), true, "夹具必须保留停止证明后才删除现场");
    await unit.exit;
  }
  fs.rmSync(f.directory, { recursive: true, force: true });
}

test("macOS 持久执行核实忽略 TERM 且继承双管道的后代，同 ID 不重放，错误指纹不停止", { skip: !available }, async () => {
  const f = fixture();
  let unit: LaunchedUnit | undefined;
  try {
    unit = await launchMacosExecution(f.evidence, f.ref, f.input, f.spec);
    let output = "";
    unit.stdout.on("data", chunk => { output += chunk.toString(); }); unit.stderr.resume?.();
    await waitFor(f.ready);
    await assert.rejects(launchMacosExecution(f.evidence, f.ref, f.input, f.spec), error => error instanceof ExecutionError && error.code === "execution_claim_failed");
    assert.equal((await stopMacosExecution(f.evidence, f.ref, "0".repeat(64))).exited, false);
    const before = fs.statSync(path.join(f.workspace, "beats")).size;
    await waitFor(() => fs.statSync(path.join(f.workspace, "beats")).size > before);
    assert.equal(await unit.entry.stop(), true);
    assert.match(fs.readFileSync(path.join(f.workspace, "descendant.term"), "utf8"), /TERM/);
    assert.equal(f.launched(), 1);
    assert.ok(output.includes("out"));
    assert.equal(f.read("stopped.json").stdoutEof, true); assert.equal(f.read("stopped.json").stderrEof, true);
    assert.equal((await stopMacosExecution(f.evidence, f.ref, f.fingerprint)).exited, true);
  } finally { await cleanup(f, unit); }
});

test("macOS 停止先手占用执行 ID，缺认领或错误指纹不能证明原启动已退出", { skip: !available }, async () => {
  const f = fixture();
  try {
    assert.equal((await stopMacosExecution(f.evidence, f.ref, f.fingerprint)).exited, false);
    assert.equal((await stopMacosExecution(f.evidence, f.ref)).exited, true);
    assert.equal((await stopMacosExecution(f.evidence, f.ref, f.fingerprint)).exited, false);
    await assert.rejects(launchMacosExecution(f.evidence, f.ref, f.input, f.spec), error => error instanceof ExecutionError && error.code === "execution_claim_failed");
    assert.equal(f.launched(), 0);
  } finally { await cleanup(f); }
});

test("macOS 确认 spawn 尚未创建 helper 的失败留未派发证明，恢复不重放", { skip: !available }, async () => {
  const f = fixture();
  f.input.workspace = path.join(f.workspace, "missing"); f.spec.workspace = f.input.workspace;
  f.fingerprint = createHash("sha256").update(JSON.stringify({ input: f.input, spec: f.spec })).digest("hex");
  try {
    await assert.rejects(launchMacosExecution(f.evidence, f.ref, f.input, f.spec), ExecutionError);
    assert.equal((await stopMacosExecution(f.evidence, f.ref, f.fingerprint)).exited, true);
    assert.ok(f.read("not-dispatched.json").token);
  } finally { await cleanup(f); }
});

test("macOS 宿主 SIGKILL 后从持久回执恢复，输出和控制断管不丢停止证明", { skip: !available }, async () => {
  const f = fixture();
  const hostPath = path.join(f.directory, "host.mjs");
  const identityModule = fileURLToPath(new URL("../packages/agent/src/execution/native-macos-identity.ts", import.meta.url));
  fs.writeFileSync(hostPath, `import fs from 'node:fs';import {launchMacosExecution} from ${JSON.stringify(identityModule)};const unit=await launchMacosExecution(${JSON.stringify(f.evidence)},${JSON.stringify(f.ref)},${JSON.stringify(f.input)},${JSON.stringify(f.spec)});unit.stdout.resume();unit.stderr.resume();setInterval(()=>{},1000);await unit.exit;`);
  const host = spawn(process.execPath, ["--import", "tsx", hostPath], { stdio: "ignore" });
  const exited = new Promise<void>(resolve => host.once("exit", () => resolve()));
  try {
    await waitFor(f.ready);
    host.kill("SIGKILL"); await exited;
    await waitFor(() => fs.existsSync(path.join(f.claimDir, "stopped.json")));
    assert.equal((await stopMacosExecution(f.evidence, f.ref, f.fingerprint)).exited, true);
    assert.equal(f.read("stopped.json").reaped, true); assert.equal(f.launched(), 1);
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await exited; await cleanup(f);
  }
});

test("macOS 监督器身份换代拒绝发信号，持久证据目录替换不能释放原占用", { skip: !available }, async () => {
  const f = fixture();
  let unit: LaunchedUnit | undefined;
  try {
    unit = await launchMacosExecution(f.evidence, f.ref, f.input, f.spec); unit.stdout.resume?.(); unit.stderr.resume?.();
    await waitFor(f.ready);
    const journalPath = path.join(f.claimDir, "supervisor.jsonl");
    const original = fs.readFileSync(journalPath, "utf8");
    const header = JSON.parse(original.split("\n", 1)[0]);
    for (const changed of [{ ...header, uniqueid: (BigInt(header.uniqueid) + 1n).toString() }, { ...header, bootId: "00000000-0000-0000-0000-000000000000" }, { ...header, pidversion: header.pidversion + 1 }]) {
      const signal = spawnSync(helper, ["--signal-supervisor", changed.machineId, changed.bootId, String(changed.pid), changed.uniqueid, changed.seconds, changed.microseconds, String(changed.pidversion >>> 0)]);
      assert.equal(signal.status, 3);
    }
    const before = fs.statSync(path.join(f.workspace, "beats")).size;
    await waitFor(() => fs.statSync(path.join(f.workspace, "beats")).size > before);
    assert.equal(fs.existsSync(path.join(f.claimDir, "stopped.json")), false);
    assert.equal(await unit.entry.stop(), true);
    const moved = f.claimDir + ".old";
    fs.renameSync(f.claimDir, moved); fs.mkdirSync(f.claimDir, { mode: 0o700 });
    for (const name of ["claim.json", "stopped.json"]) fs.copyFileSync(path.join(moved, name), path.join(f.claimDir, name));
    assert.equal((await stopMacosExecution(f.evidence, f.ref, f.fingerprint)).exited, false);
    fs.rmdirSync(path.join(moved, "stop-requested"));
    fs.renameSync(f.claimDir, f.claimDir + ".replacement"); fs.renameSync(moved, f.claimDir);
  } finally { await cleanup(f, unit); }
});


test("macOS helper SIGKILL 后无停止回执，只保守未核实且不向旧 worker PID 发信号", { skip: !available }, async () => {
  const f = fixture();
  const source = fileURLToPath(new URL("../packages/agent/src/execution/native-macos-supervisor.c", import.meta.url));
  const injector = path.join(f.directory, "kill-exact.c"), binary = path.join(f.directory, "kill-exact");
  fs.writeFileSync(injector, `#define main helper_main\n#include ${JSON.stringify(source)}\n#undef main\nint main(int argc, char **argv) { if(argc != 6) return 2; uint64_t v[5]; for(int i=0;i<5;i++) if(!parse_unsigned(argv[i+1],&v[i]))return 2; struct process_info p; if(identity((pid_t)v[0],&p)!=1 || p.unique.uniqueid!=v[1] || p.bsd.pbi_start_tvsec!=v[2] || p.bsd.pbi_start_tvusec!=v[3] || (uint32_t)p.unique.pidversion!=v[4])return 3; audit_token_t t={{0}};t.val[5]=p.bsd.pbi_pid;t.val[7]=p.unique.pidversion;return proc_signal_with_audittoken(&t,SIGKILL)==0?0:4; }\n`);
  assert.equal(spawnSync("/usr/bin/clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", injector, "-o", binary]).status, 0);
  let unit: LaunchedUnit | undefined;
  try {
    unit = await launchMacosExecution(f.evidence, f.ref, f.input, f.spec); unit.stdout.resume?.(); unit.stderr.resume?.();
    await waitFor(f.ready);
    const identity = JSON.parse(fs.readFileSync(path.join(f.claimDir, "supervisor.jsonl"), "utf8").split("\n", 1)[0]);
    assert.equal(spawnSync(binary, [String(identity.pid), identity.uniqueid, identity.seconds, identity.microseconds, String(identity.pidversion >>> 0)]).status, 0);
    assert.equal((await unit.exit).signal, "SIGKILL");
    assert.equal((await stopMacosExecution(f.evidence, f.ref, f.fingerprint)).exited, false);
    assert.equal(fs.existsSync(path.join(f.claimDir, "stopped.json")), false);
    const before = fs.statSync(path.join(f.workspace, "beats")).size;
    await waitFor(() => fs.statSync(path.join(f.workspace, "beats")).size > before);
  } finally {
    f.releaseFixture();
    if (unit) await waitFor(() => fs.existsSync(path.join(f.workspace, "root.finished")) && fs.existsSync(path.join(f.workspace, "descendant.finished")));
    await cleanup(f);
  }
});

test("macOS 输出背压不阻塞停止核实，丢失预览与进程停止分别记录", { skip: !available }, async () => {
  const f = fixture();
  fs.writeFileSync(f.input.workerPath, `import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(path.join(f.workspace, "ready"))},'ready');process.stdout.write(Buffer.alloc(4*1024*1024,97));process.stderr.write(Buffer.alloc(4*1024*1024,98));setInterval(()=>{},1000);`);
  let unit: LaunchedUnit | undefined;
  try {
    unit = await launchMacosExecution(f.evidence, f.ref, f.input, f.spec);
    await waitFor(() => fs.existsSync(path.join(f.workspace, "ready")));
    assert.equal(await unit.entry.stop(), true);
    const stopped = f.read("stopped.json");
    assert.equal(stopped.reaped, true); assert.equal(stopped.stdoutEof, true); assert.equal(stopped.stderrEof, true);
    assert.equal(stopped.outputComplete, false);
  } finally { await cleanup(f, unit); }
});

test("macOS 完全访问继承过滤后的环境，私有认领与指纹不保存环境秘密", { skip: !available }, async () => {
  const f = fixture();
  const secret = "probe-secret-" + randomBytes(8).toString("hex");
  const prior = process.env.RUUKOTO_BG_ENV_CHECK, owner = process.env.RUUKOTO_OWNER_TOKEN;
  process.env.RUUKOTO_BG_ENV_CHECK = secret; process.env.RUUKOTO_OWNER_TOKEN = secret;
  fs.writeFileSync(f.input.workerPath, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(f.workspace, "environment"))},JSON.stringify({inherited:process.env.RUUKOTO_BG_ENV_CHECK,owner:process.env.RUUKOTO_OWNER_TOKEN??null}));setInterval(()=>{},1000);`);
  let unit: LaunchedUnit | undefined;
  try {
    unit = await launchMacosExecution(f.evidence, f.ref, f.input, f.spec); unit.stdout.resume?.(); unit.stderr.resume?.();
    await waitFor(() => fs.existsSync(path.join(f.workspace, "environment")));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.workspace, "environment"), "utf8")), { inherited: secret, owner: null });
    assert.equal(fs.readFileSync(path.join(f.claimDir, "claim.json"), "utf8").includes(secret), false);
    assert.equal(fs.readFileSync(path.join(f.claimDir, "supervisor.jsonl"), "utf8").includes(secret), false);
    assert.equal(await unit.entry.stop(), true);
  } finally {
    if (prior === undefined) delete process.env.RUUKOTO_BG_ENV_CHECK; else process.env.RUUKOTO_BG_ENV_CHECK = prior;
    if (owner === undefined) delete process.env.RUUKOTO_OWNER_TOKEN; else process.env.RUUKOTO_OWNER_TOKEN = owner;
    await cleanup(f, unit);
  }
});


test("macOS 停止标记抢先到达 fork 后启动门，命令零派发且回执可恢复", { skip: !available }, async () => {
  const f = fixture();
  const source = fileURLToPath(new URL("../packages/agent/src/execution/native-macos-supervisor.c", import.meta.url));
  const wrapper = path.join(f.directory, "gate.c"), binary = path.join(f.directory, "gate");
  fs.writeFileSync(wrapper, `#define main helper_main\n#include ${JSON.stringify(source)}\n#undef main\nint main(void) { signal(SIGPIPE,SIG_IGN); durable=true; signal(SIGTERM,request_stop);signal(SIGINT,request_stop);signal(SIGHUP,request_stop);if(!prepare_durable(${JSON.stringify(f.directory)},"${"1".repeat(32)}","${"2".repeat(64)}")||!owner_processes(&baseline))return 2;launchd_verified=launchd_identity(&launchd);int gate[2];if(pipe(gate))return 3;worker_pid=fork();if(!worker_pid){close(gate[1]);dup2(output_write[0],1);dup2(output_write[1],2);close(output[0].fd);close(output[1].fd);close(output_write[0]);close(output_write[1]);char start;if(read(gate[0],&start,1)!=1)_exit(126);execl("/bin/sh","sh","-c","touch ${f.workspace}/launched",(char *)0);_exit(127);}close(gate[0]);for(int i=0;i<2;i++){close(output_write[i]);output_write[i]=-1;}if(identity(worker_pid,&root)!=1||!append(&members,&root))return 4;if(mkdirat(evidence_dir,"stop-requested",0700)||fsync(evidence_dir))return 5;pause_observation(0);if(!stop_requested && write(gate[1],"s",1)!=1)return 6;close(gate[1]);last_sample=monotonic();bool stopped=stop_worker();status_message("stopped",stopped?"verified":uncertain_reason,stopped);waitpid(worker_pid,NULL,0);return stopped?0:7;}\n`);
  try {
    const compiled = spawnSync("/usr/bin/clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", wrapper, "-o", binary], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    run.stdout!.resume(); run.stderr!.resume(); run.stdio[3]!.on("data", () => undefined);
    const exit = await new Promise<number | null>(resolve => run.once("exit", resolve));
    assert.equal(exit, 0);
    assert.equal(fs.existsSync(path.join(f.workspace, "launched")), false);
    const stopped = JSON.parse(fs.readFileSync(path.join(f.directory, "stopped.json"), "utf8"));
    assert.equal(stopped.reaped, true); assert.equal(stopped.stdoutEof, true); assert.equal(stopped.stderrEof, true);
  } finally { await cleanup(f); }
});

test("macOS 完全访问只核实原执行组和已累计后代，未知主动脱离者仍须释放继承管道", { skip: !available }, async t => {
  for (const mode of ["ordinary-double-fork", "detached-closed-pipes", "detached-inherited-pipes", "known-detached-short-ancestry", "known-joined-unseen-group"] as const) await t.test(mode, async () => {
    const f = fixture();
    const source = fileURLToPath(new URL("../packages/agent/src/execution/native-macos-supervisor.c", import.meta.url));
    const wrapper = path.join(f.directory, "scope.c"), binary = path.join(f.directory, "scope");
    const ready = path.join(f.workspace, "orphan"), release = path.join(f.workspace, "release"), finished = path.join(f.workspace, "finished");
    fs.writeFileSync(wrapper, `#define main helper_main\n#include ${JSON.stringify(source)}\n#undef main\nint main(void) {
      signal(SIGPIPE,SIG_IGN);durable=true;
      if(!prepare_durable(${JSON.stringify(f.directory)},"${"1".repeat(32)}","${"2".repeat(64)}")||!owner_processes(&baseline))return 2;
      launchd_verified=launchd_identity(&launchd);worker_pid=fork();
      if(!worker_pid){
        if(setsid()<0)_exit(126);dup2(output_write[0],1);dup2(output_write[1],2);close(output[0].fd);close(output[1].fd);close(output_write[0]);close(output_write[1]);
        pid_t parent=fork();if(!parent){
          ${mode === "known-detached-short-ancestry" || mode === "known-joined-unseen-group" ? `int known=open("${f.workspace}/known",O_WRONLY|O_CREAT,0600);close(known);while(access("${f.workspace}/go",F_OK))usleep(1000);${mode === "known-joined-unseen-group" ? `pid_t group=fork();if(!group){if(setpgid(0,0))_exit(124);int grouped=open("${f.workspace}/group",O_WRONLY|O_CREAT,0600);close(grouped);while(access("${f.workspace}/joined",F_OK))usleep(1000);_exit(0);}while(access("${f.workspace}/group",F_OK))usleep(1000);if(setpgid(0,group))_exit(123);int joined=open("${f.workspace}/joined",O_WRONLY|O_CREAT,0600);close(joined);` : "if(setsid()<0)_exit(125);"}pid_t transient=fork();if(transient)_exit(0);` : ""}
          pid_t orphan=fork();if(orphan)_exit(0);
          ${mode === "ordinary-double-fork" || mode === "known-detached-short-ancestry" || mode === "known-joined-unseen-group" ? "" : "if(setsid()<0)_exit(125);"}
          ${mode === "detached-closed-pipes" || mode === "known-detached-short-ancestry" || mode === "known-joined-unseen-group" ? "close(1);close(2);" : ""}
          signal(SIGTERM,SIG_IGN);while(getppid()!=1)usleep(1000);
          int ready=open(${JSON.stringify(ready)},O_WRONLY|O_CREAT|O_EXCL,0600);dprintf(ready,"%d",getpid());close(ready);
          while(access(${JSON.stringify(release)},F_OK)!=0)usleep(1000);
          int finished=open(${JSON.stringify(finished)},O_WRONLY|O_CREAT|O_EXCL,0600);close(finished);_exit(0);
        }
        for(;;)pause();
      }
      for(int i=0;i<2;i++){close(output_write[i]);output_write[i]=-1;}
      if(identity(worker_pid,&root)!=1||!append(&members,&root))return 3;
      ${mode === "known-detached-short-ancestry" || mode === "known-joined-unseen-group" ? `for(int i=0;i<5000&&access("${f.workspace}/known",F_OK);i++)usleep(1000);struct process_list initial={0};last_sample=monotonic();if(!sample(&initial))return 8;free(initial.items);int go=open("${f.workspace}/go",O_WRONLY|O_CREAT,0600);close(go);` : ""}
      for(int i=0;i<5000&&access(${JSON.stringify(ready)},F_OK);i++)usleep(1000);
      int ready=open(${JSON.stringify(ready)},O_RDONLY);char pid_text[32]={0};if(ready<0||read(ready,pid_text,sizeof(pid_text)-1)<=0)return 4;close(ready);pid_t orphan=atoi(pid_text);
      struct process_list current={0};last_sample=monotonic();if(!sample(&current))return 5;free(current.items);
      bool stopped=stop_worker();if(!finish_output())stopped=false;status_message("stopped",stopped?"verified":uncertain_reason,stopped);
      struct process_info actual;bool alive=identity(orphan,&actual)==1&&!zombie(&actual);
      dprintf(3,"{\\"type\\":\\"orphan\\",\\"alive\\":%s}\\n",alive?"true":"false");
      int release=open(${JSON.stringify(release)},O_WRONLY|O_CREAT|O_EXCL,0600);close(release);
      if(alive)for(int i=0;i<5000&&access(${JSON.stringify(finished)},F_OK);i++)usleep(1000);
      waitpid(worker_pid,NULL,0);return 0;
    }\n`);
    try {
      const compiled = spawnSync("/usr/bin/clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", wrapper, "-o", binary], { encoding: "utf8" });
      assert.equal(compiled.status, 0, compiled.stderr);
      const run = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
      run.stdout!.resume(); run.stderr!.resume(); let status = "";
      run.stdio[3]!.on("data", chunk => { status += chunk.toString(); });
      const exit = await new Promise<number | null>(resolve => run.once("close", resolve));
      assert.equal(exit, 0, status);
      const messages = status.trim().split("\n").map(line => JSON.parse(line));
      const stopped = messages.find(message => message.type === "stopped"), orphan = messages.find(message => message.type === "orphan");
      assert.equal(stopped.reaped, mode !== "detached-inherited-pipes" && mode !== "known-detached-short-ancestry" && mode !== "known-joined-unseen-group", status);
      assert.equal(orphan.alive, mode !== "ordinary-double-fork", status);
      if (mode === "detached-inherited-pipes") assert.equal(stopped.reason, "output_pipe_not_closed");
      if (mode === "known-detached-short-ancestry" || mode === "known-joined-unseen-group") assert.equal(stopped.reason, "unknown_new_orphan");
    } finally { await cleanup(f); }
  });
});

test("macOS 启动门前的根进程快照不把宿主组和会话纳入后台停止范围", { skip: process.platform !== "darwin" }, async () => {
  const f = fixture();
  const source = fileURLToPath(new URL("../packages/agent/src/execution/native-macos-supervisor.c", import.meta.url));
  const wrapper = path.join(f.directory, "startup-scope.c"), binary = path.join(f.directory, "startup-scope");
  fs.writeFileSync(wrapper, `#include <assert.h>
    #include <libproc.h>
    #include <unistd.h>
    int fake_proc_pidinfo(int,int,uint64_t,void *,int);
    int fake_proc_listpids(uint32_t,uint32_t,void *,int);
    pid_t fake_getsid(pid_t);
    #define proc_pidinfo fake_proc_pidinfo
    #define proc_listpids fake_proc_listpids
    #define getsid fake_getsid
    #define main helper_main
    #include ${JSON.stringify(source)}
    #undef main
    static struct process_info snapshot,confirmed,candidate;
    static pid_t root_session;
    static int root_reads;
    int fake_proc_pidinfo(int pid,int flavor,uint64_t arg,void *buffer,int size) {
      (void)arg;assert(flavor==18 && size==sizeof(struct process_info));
      const struct process_info *value=pid==10?(root_reads++?&confirmed:&snapshot):&candidate;
      assert((uint32_t)pid==value->bsd.pbi_pid);memcpy(buffer,value,sizeof(*value));return sizeof(*value);
    }
    int fake_proc_listpids(uint32_t type,uint32_t uid,void *buffer,int size) {
      (void)type;(void)uid;if(!buffer)return sizeof(pid_t);assert(size>=(int)sizeof(pid_t));*(pid_t *)buffer=10;return sizeof(pid_t);
    }
    pid_t fake_getsid(pid_t pid) { return pid==10?root_session:700; }
    int main(void) {
      durable=true;worker_pid=10;root.bsd.pbi_pid=10;root.bsd.pbi_pgid=10;
      root.bsd.pbi_start_tvsec=1000;root.unique.uniqueid=1000;root.unique.pidversion=100;
      candidate=root;candidate.bsd.pbi_pid=88;candidate.bsd.pbi_ppid=1;
      candidate.bsd.pbi_pgid=500;candidate.unique.uniqueid=2000;
      assert(append(&members,&root));
      for(int mode=0;mode<3;mode++) {
        snapshot=root;snapshot.bsd.pbi_pgid=mode==2?10:500;confirmed=snapshot;
        if(mode==1)confirmed.bsd.pbi_pgid=10;
        root_session=mode==0?700:10;root_reads=0;managed_scopes_length=0;last_sample=0;
        struct process_list current={0};assert(sample(&current));free(current.items);
        struct process_list orphan={.items=&candidate,.length=1};
        assert(!new_orphan(&orphan,false));assert(!uncertain);
      }
      candidate.bsd.pbi_pgid=10;struct process_list orphan={.items=&candidate,.length=1};
      assert(new_orphan(&orphan,false));free(members.items);free(managed_scopes);return 0;
    }\n`);
  try {
    const compiled = spawnSync("/usr/bin/clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", wrapper, "-o", binary], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  } finally { await cleanup(f); }
});
