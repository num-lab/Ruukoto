#!/usr/bin/env node
/**
 * 受控 helper 替身（agent-direction issue 09 的离线测试替身，仅测试使用）。
 *
 * 与 deploy/systemd/ruukoto-service.mjs 同一协议（应答 = stderr 上唯一一条
 * RUUKOTO_SERVICE_REPLY 前缀单行 JSON、fd1 透传「systemctl show 风格」原始行、
 * 同一形态校验与拒绝原因码），但用固定状态目录内的文件模拟 systemd：不要求
 * root、不触达 systemd/提权/sudoers。真实 systemd/提权证据由 smoke-09（真实
 * Linux）覆盖，本替身只证明宿主侧协议与策略语义。
 *
 * 状态目录解析（与生产 helper 的唯一路径差异；它不是生产安全边界）：
 * RUUKOTO_FAKE_HELPER_DIR 优先；缺省回退到本脚本自身所在目录——service-tools
 * 客户端清空环境（env 只含 PATH）后，测试把本替身复制到每个用例的状态目录并
 * 以副本路径作 helperPath，副本目录即状态目录。目录内容（测试预置/注入）：
 *   services.json   策略（同生产 schema；机器身份校验放宽为「文件存在即可」，machineId
 *                   原样回显；文件字节 sha256 = policyRevision）
 *   units/<unit>    单元定义（内容 sha256 = unitRevision；改写即触发 revision_mismatch）
 *   state.json      { [unit]: { loadState, activeState, subState, mainPid, invocationId,
 *                     result, activeEnterTimestamp, starts, aliasOf? } }
 *   ops/<hostOpId>/ 认领目录（atomic mkdir 同生产：EEXIST → already_claimed；claim.json）
 * 控制标志文件（测试注入故障）：
 *   reload-required            restart 拒绝 reload_required（launched:false）
 *   restart-delay-ms           内容=毫秒数；restart 在「模拟执行」前等待，等待期间每 50ms
 *                              查认领目录 stop-requested，发现即中止（exitCode 非零 = 143，
 *                              不增加 starts）
 *   fail-inspect-after-restart 第一次 restart 成功后的下一个 inspect 拒绝 internal（一次性）
 *   garbage-protocol           应答行写无前缀的非 JSON（协议错误）
 *   fd2-noise                  应答前向 stderr 写无前缀噪声行（模拟 systemd-run
 *                              --pipe 透传命令单元 stderr 的真实形态；客户端仍应
 *                              按前缀行正确解析）
 *   stop-query-fails           stop-op 应答 exited:false（detail query_failed）
 *   calls.log                  每次调用追加一行 [verb, ...args] JSON
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const HOST_OP_ID = /^op_[0-9a-f]{24}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OP_UNIT_PREFIX = "ruukoto-service-op-";

/** 固定拒绝清单（与生产 helper 相同）。 */
const DENY_EXACT = new Set([
  "ruukoto-backend.service",
  "docker.service",
  "docker.socket",
  "containerd.service",
  "containerd.socket",
  "dbus.service",
  "dbus.socket",
]);
const DENY_PREFIX = ["ruukoto-exec-", "ruukoto-service-op-", "systemd-"];

class Refuse extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.reasonCode = reasonCode;
  }
  // 与生产一致：所有拒绝路径都在「模拟派发」之前
  get launched() {
    return false;
  }
}

const DIR = process.env.RUUKOTO_FAKE_HELPER_DIR ?? path.dirname(fs.realpathSync(process.argv[1]));
const POLICY_PATH = path.join(DIR, "services.json");
const STATE_PATH = path.join(DIR, "state.json");
const UNITS_DIR = path.join(DIR, "units");
const OPS_DIR = path.join(DIR, "ops");
const CALLS_LOG = path.join(DIR, "calls.log");
const flag = (name) => fs.existsSync(path.join(DIR, name));

function reply(obj) {
  // 模拟 systemd-run --pipe 透传命令单元 stderr 的噪声（位于应答前缀行之前）
  if (flag("fd2-noise")) {
    fs.writeSync(2, "runit[1]: sim op-unit stderr noise line 1 (not a reply)\nFailed to reload daemon units? simulated noise\n");
  }
  if (flag("garbage-protocol")) {
    fs.writeSync(2, "GARBAGE{not-json}\n");
    return;
  }
  fs.writeSync(2, `RUUKOTO_SERVICE_REPLY ${JSON.stringify({ v: 1, ...obj })}\n`);
}

function logCall() {
  try {
    fs.appendFileSync(CALLS_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
  } catch {
    // 日志失败不影响协议路径
  }
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 精确规范的 .service 名（同生产 helper）。 */
function assertWellFormedUnit(unit) {
  if (typeof unit !== "string" || unit.length === 0 || unit.length > 128) {
    throw new Refuse("unit_invalid", "单元名非法（空或超长）");
  }
  if (!/^[A-Za-z0-9_.-]+\.service$/.test(unit)) {
    throw new Refuse("unit_invalid", `单元名必须是精确规范的 .service 名（拒绝路径/空白/选项/通配符）：${JSON.stringify(unit)}`);
  }
  if (unit.includes("@")) {
    throw new Refuse("unit_invalid", `拒绝模板实例单元：${unit}`);
  }
  if (DENY_EXACT.has(unit) || DENY_PREFIX.some((p) => unit.startsWith(p))) {
    throw new Refuse("unit_denied", `固定拒绝把基础设施列作管理目标：${unit}`);
  }
}

function loadPolicy() {
  let raw;
  try {
    raw = fs.readFileSync(POLICY_PATH);
  } catch (err) {
    throw new Refuse("policy_unreadable", `策略不可读：${err.message}`);
  }
  let policy;
  try {
    policy = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Refuse("policy_invalid", "策略不是合法 JSON");
  }
  // 机器身份校验放宽：文件存在即可，machineId 原样回显（替身差异，非生产安全边界）
  const machineId = typeof policy.machineId === "string" && policy.machineId ? policy.machineId : "fake-machine-relaxed";
  if (!Number.isInteger(policy.inspectUid) || policy.inspectUid <= 0 || !Number.isInteger(policy.inspectGid) || policy.inspectGid <= 0) {
    throw new Refuse("policy_invalid", "策略的执行 UID/GID 非法");
  }
  if (typeof policy.services !== "object" || policy.services === null || Array.isArray(policy.services)) {
    throw new Refuse("policy_invalid", "策略缺少 services 清单");
  }
  for (const unit of Object.keys(policy.services)) assertWellFormedUnit(unit);
  return { policy, machineId, policyRevision: sha256Hex(raw) };
}

function policyEntry(policy, unit) {
  assertWellFormedUnit(unit);
  const entry = policy.services[unit];
  if (entry === undefined) {
    throw new Refuse("not_whitelisted", `目标不在服务管理白名单内：${unit}`);
  }
  const actions = Array.isArray(entry?.actions) ? entry.actions : [];
  return { ...entry, actions };
}

function unitRevisionOf(unit) {
  let content;
  try {
    content = fs.readFileSync(path.join(UNITS_DIR, unit));
  } catch (err) {
    throw new Refuse("revision_unreadable", `单元定义来源不可读：${unit}（${err.message}）`);
  }
  return sha256Hex(content);
}

function readState(unit) {
  let all;
  try {
    all = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (err) {
    throw new Refuse("internal", `替身状态不可读：${err.message}`);
  }
  const state = all[unit];
  if (!state) throw new Refuse("internal", `替身缺少单元状态：${unit}`);
  return { all, state };
}

function assertNotAlias(state, unit) {
  if (state.aliasOf) {
    throw new Refuse("alias_refused", `目标是别名（实际单元 ${state.aliasOf}），白名单只认精确名：${unit}`);
  }
}

function cmdInspect(unit, inspectionId, expectedMachineId) {
  const { policy, machineId, policyRevision } = loadPolicy();
  policyEntry(policy, unit);
  if (inspectionId !== undefined) {
    if (!/^inspect_[0-9a-f]{24}$/.test(inspectionId) || machineId !== expectedMachineId) throw new Refuse("wrong_machine", "检查身份或机器不符");
    const dir = path.join(DIR, "inspections", inspectionId);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try { fs.mkdirSync(dir); } catch (error) { if (error.code === "EEXIST") throw new Refuse("already_claimed", "原检查已认领"); throw error; }
    fs.writeFileSync(path.join(dir, "claim.json"), JSON.stringify({ inspectionId, machineId, pid: process.pid }));
    if (flag("inspect-delay-ms")) sleepMs(Number(fs.readFileSync(path.join(DIR, "inspect-delay-ms"), "utf8")));
    if (fs.existsSync(path.join(dir, "stop-requested"))) throw new Refuse("stop_requested", "检查已停止");
  }
  const { state } = readState(unit);
  assertNotAlias(state, unit);
  if (flag("fail-inspect-after-restart") && flag("restarted")) {
    fs.rmSync(path.join(DIR, "fail-inspect-after-restart"), { force: true });
    throw new Refuse("internal", "（注入）restart 后的状态查询失败");
  }
  // 「systemctl show 风格」原始行经 fd1 透传（由调用方入产物）
  const lines = [
    `Id=${unit}`,
    `LoadState=${state.loadState}`,
    `ActiveState=${state.activeState}`,
    `SubState=${state.subState}`,
    `MainPID=${state.mainPid}`,
    `InvocationID=${state.invocationId}`,
    `Result=${state.result}`,
    `ActiveEnterTimestamp=${state.activeEnterTimestamp}`,
  ];
  fs.writeSync(1, lines.join("\n") + "\n");
  reply({
    verb: inspectionId === undefined ? "inspect" : "inspect-op",
    ...(inspectionId === undefined ? {} : { inspectionId }),
    ok: true,
    machineId,
    policyRevision,
    unitRevision: unitRevisionOf(unit),
    unit,
    state: {
      id: unit,
      loadState: state.loadState,
      activeState: state.activeState,
      subState: state.subState,
      mainPid: Number(state.mainPid) || 0,
      invocationId: state.invocationId,
      result: state.result,
      activeEnterTimestamp: state.activeEnterTimestamp,
    },
    execIdentity: { uid: policy.inspectUid, gid: policy.inspectGid },
    observedAt: new Date().toISOString(),
  });
}

function opUnitFor(hostOpId) {
  return `${OP_UNIT_PREFIX}${hostOpId}.service`;
}

function cmdRestart(hostOpId, expectedPolicyRev, expectedUnitRev, unit) {
  const { policy, machineId, policyRevision } = loadPolicy();
  if (!HOST_OP_ID.test(hostOpId)) throw new Refuse("op_invalid", "操作 ID 形态非法（须为 op_ + 24 位小写十六进制）");
  if (!HEX64.test(expectedPolicyRev) || !HEX64.test(expectedUnitRev)) throw new Refuse("revision_invalid", "修订指纹形态非法");
  const entry = policyEntry(policy, unit);
  if (!entry.actions.includes("restart")) throw new Refuse("action_denied", `策略不允许对 ${unit} 执行 restart`);

  // 原子认领一次执行权（同生产：mkdir；同 ID 拒绝再次启动，标记持久保留）
  const claimDir = path.join(OPS_DIR, hostOpId);
  try {
    fs.mkdirSync(claimDir, { mode: 0o700 });
  } catch (err) {
    if (err.code === "EEXIST") throw new Refuse("already_claimed", `同一操作 ID 已认领过执行权，拒绝再次启动：${hostOpId}`);
    throw new Refuse("claim_failed", `执行权认领失败：${err.message}`);
  }
  fs.writeFileSync(path.join(claimDir, "claim.json"), JSON.stringify({ version: 2, claimedBy: "restart", launcherPid: process.pid, unit, expectedPolicyRev, expectedUnitRev, claimedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });

  // 停止协议先手：认领后、启动前出现 stop-requested 则拦下迟到启动
  if (fs.existsSync(path.join(claimDir, "stop-requested"))) {
    throw new Refuse("stop_requested", `操作 ${hostOpId} 已被停止协议拦下（启动前收到停止标记）`);
  }

  // 请求前复核（同生产语序）：策略修订 → 别名 → 单元修订 → reload_required
  if (policyRevision !== expectedPolicyRev) {
    throw new Refuse("revision_mismatch", "策略修订与批准快照不符，拒绝请求 systemd");
  }
  const { all, state } = readState(unit);
  assertNotAlias(state, unit);
  if (unitRevisionOf(unit) !== expectedUnitRev) {
    throw new Refuse("revision_mismatch", "单元定义修订与批准快照不符，拒绝请求 systemd");
  }
  if (flag("reload-required")) {
    throw new Refuse("reload_required", "单元已加载配置与磁盘不一致（NeedDaemonReload=yes），拒绝请求 systemd");
  }

  const opUnit = opUnitFor(hostOpId);
  // 「模拟执行」前的受控等待：期间每 50ms 查 stop-requested，发现即中止（不增加 starts）
  let exitCode = 0;
  if (flag("restart-delay-ms")) {
    const delay = Number(fs.readFileSync(path.join(DIR, "restart-delay-ms"), "utf8").trim()) || 0;
    const deadline = Date.now() + delay;
    while (Date.now() < deadline) {
      if (fs.existsSync(path.join(claimDir, "stop-requested"))) {
        exitCode = 143;
        break;
      }
      sleepMs(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }
  if (exitCode === 0) {
    const next = (Number(state.starts) || 0) + 1;
    all[unit] = {
      ...state,
      activeState: "active",
      subState: "running",
      result: "success",
      mainPid: 4000 + next,
      invocationId: `inv-${next}-${randomBytes(3).toString("hex")}`,
      activeEnterTimestamp: new Date().toISOString(),
      starts: next,
    };
    delete all[unit].aliasOf;
    fs.writeFileSync(STATE_PATH, JSON.stringify(all, null, 2));
    fs.writeFileSync(path.join(DIR, "restarted"), new Date().toISOString() + "\n", { mode: 0o600 });
  }
  if (exitCode === 0 && flag("fail-after-launch")) {
    // 注入：systemd 派发后的意外失败（生产语义：已按已启动上报，调用方记效果未知）
    reply({ verb: "restart", ok: false, launched: true, reasonCode: "internal", error: "注入：派发后失败" });
    return;
  }
  reply({ verb: "restart", ok: true, machineId, hostOpId, opUnit, launched: true, execIdentity: "root", exitCode, observedAt: new Date().toISOString() });
}

function cmdStopOp(hostOpId) {
  const { machineId } = loadPolicy(); // 部署读取验证（策略内容不用于停止协议）
  if (!HOST_OP_ID.test(hostOpId)) throw new Refuse("op_invalid", "操作 ID 形态非法");
  const claimDir = path.join(OPS_DIR, hostOpId);
  // 停止先阻止后续启动：认领目录不存在时由停止协议创建（restart 见 EEXIST 即拒绝）
  let created = false;
  try { fs.mkdirSync(claimDir, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (created) fs.writeFileSync(path.join(claimDir, "claim.json"), JSON.stringify({ version: 2, claimedBy: "stop-op", claimedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.writeFileSync(path.join(claimDir, "stop-requested"), new Date().toISOString() + "\n", { mode: 0o600 });
  const opUnit = opUnitFor(hostOpId);
  if (flag("stop-query-fails")) {
    reply({ verb: "stop-op", ok: true, machineId, hostOpId, opUnit, launcherExited: false, exited: false, detail: "query_failed" });
    return;
  }
  let launchEnded = false;
  const deadline = Date.now() + 1000;
  do {
    let claim;
    try { claim = JSON.parse(fs.readFileSync(path.join(claimDir, "claim.json"), "utf8")); } catch { break; }
    if (claim.version !== 2) break;
    if (claim.claimedBy === "stop-op") launchEnded = true;
    else if (claim.claimedBy === "restart" && Number.isSafeInteger(claim.launcherPid) && claim.launcherPid > 0) {
      // 替身没有后代；PID 探针只模拟短期夹具，生产用 starttime/bootId 与进程组核实。
      try { process.kill(claim.launcherPid, 0); } catch (error) { launchEnded = error.code === "ESRCH"; }
    }
    if (launchEnded) break;
    sleepMs(10);
  } while (Date.now() < deadline);
  reply({ verb: "stop-op", ok: true, machineId, hostOpId, opUnit, launcherExited: launchEnded, exited: launchEnded });
}

function cmdStopInspect(inspectionId, expectedMachineId) {
  const { machineId } = loadPolicy();
  if (!/^inspect_[0-9a-f]{24}$/.test(inspectionId) || machineId !== expectedMachineId) throw new Refuse("wrong_machine", "检查身份或机器不符");
  const dir = path.join(DIR, "inspections", inspectionId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  let created = false;
  try { fs.mkdirSync(dir); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (created) fs.writeFileSync(path.join(dir, "claim.json"), JSON.stringify({ inspectionId, machineId, stoppedFirst: true }));
  fs.writeFileSync(path.join(dir, "stop-requested"), "");
  const claim = JSON.parse(fs.readFileSync(path.join(dir, "claim.json"), "utf8"));
  let exited = claim.stoppedFirst === true;
  if (!exited && Number.isSafeInteger(claim.pid)) {
    // 替身没有后代；生产的 boot/starttime/进程组核实另由 Linux helper 用例证明。
    try { process.kill(claim.pid, 0); } catch (error) { exited = error.code === "ESRCH"; }
  }
  if (flag("inspection-stop-fails")) exited = false;
  reply({ verb: "stop-inspect", ok: true, machineId, inspectionId, exited });
}

function main() {
  const args = process.argv.slice(2);
  const verb = args[0];
  switch (verb) {
    case "inspect":
      if (args.length !== 2) throw new Refuse("usage", "用法：inspect <unit>");
      return cmdInspect(args[1]);
    case "inspect-op":
      if (args.length !== 4) throw new Refuse("usage", "inspect-op 参数不符");
      return cmdInspect(args[3], args[1], args[2]);
    case "stop-inspect":
      if (args.length !== 3) throw new Refuse("usage", "stop-inspect 参数不符");
      return cmdStopInspect(args[1], args[2]);
    case "restart":
      if (args.length !== 5) throw new Refuse("usage", "用法：restart <hostOpId> <policyRev> <unitRev> <unit>");
      return cmdRestart(args[1], args[2], args[3], args[4]);
    case "stop-op":
      if (args.length !== 2) throw new Refuse("usage", "用法：stop-op <hostOpId>");
      return cmdStopOp(args[1]);
    default:
      throw new Refuse("usage", "用法：<inspect|restart|stop-op> …（固定协议，无自由参数）");
  }
}

logCall();
try {
  main();
} catch (err) {
  if (err instanceof Refuse) {
    reply({ verb: process.argv[2] ?? "", ok: false, launched: false, reasonCode: err.reasonCode, error: err.message });
    process.exit(64);
  }
  reply({ verb: process.argv[2] ?? "", ok: false, launched: false, reasonCode: "internal", error: (err && err.message) || String(err) });
  process.exit(1);
}
