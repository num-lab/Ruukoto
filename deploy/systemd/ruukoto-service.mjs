#!/usr/bin/env node
/**
 * ruukoto 服务器服务管理 helper（agent-direction issue 09）。
 * Note: 见 .agents/notes/implemented/feature/2026-10-12-full-access-current-account.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-03-service-management-helper.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-17-service-inspection-identity.md
 *
 * 唯一可信的 systemd 服务管理入口：root 拥有 0700，仅启动账户经 sudoers 以
 * 固定 argv 调用；Node 标准库实现，无第三方依赖，不接受环境变量配置。
 *
 * 协议（应答 = stderr 上唯一一条 `RUUKOTO_SERVICE_REPLY ` 前缀单行 JSON；
 * fd1 透传原始 systemctl 输出、fd2 其余内容同为原始证据输出；restart 路径里
 * systemd-run --pipe 会把命令单元的 stderr 透传进 fd2，机器调用方按前缀行提取，
 * 其余行一律视为噪声证据。不用 fd3：sudo 默认关闭 fd ≥3（closefrom=3），fd3
 * 在生产必然断开）：
 *   inspect <unit>                              白名单内服务状态与修订（systemctl
 *                                               show 显式降到策略中的检查 UID/GID）
 *   inspect-op <inspectionId> <machineId> <unit>  先持久认领，再执行同组只读检查
 *   stop-inspect <inspectionId> <machineId>       阻止迟到启动，只观察原启动器组退出
 *   restart <hostOpId> <policyRev> <unitRev> <unit>
 *                                               原子认领（mkdir，同 ID 拒绝再次启动）
 *                                               → 核对修订与已加载配置 → systemd-run
 *                                               --pipe --wait 的短命命令单元中以 root
 *                                               执行固定 systemctl --system restart
 *   stop-op <hostOpId>                          只停派生命令单元 ruukoto-service-op-
 *                                               <hostOpId>.service，启动器进程组和
 *                                               整个单元均退出才报告 exited:true
 *
 * 纪律：无 shell 字符串、无自由参数；目标必须精确匹配 root 拥有的策略（拒绝别名
 * /模板实例/路径/通配符/选项注入/额外参数）；固定拒绝后台、Docker、执行工作进程
 * 与本 helper 操作单元；策略/操作目录/自身及其父目录属主与写权限每次调用都验证；
 * 同 hostOpId 的认领标记持久保留（只证明已认领，不是服务已重启的证据）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const POLICY_PATH = "/etc/ruukoto/services.json";
const OPS_DIR = "/var/lib/ruukoto/service-ops";
const MACHINE_ID_PATH = "/etc/machine-id";
const SYSTEMCTL = "/usr/bin/systemctl";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const OP_UNIT_PREFIX = "ruukoto-service-op-";
const RUNTIME_MAX_SEC = 120;
const STOP_POLL_MS = 200;
const STOP_TIMEOUT_MS = 8000;

/** 固定拒绝清单（防策略误配；策略本身 root  authored）：后台、Docker、执行工作进程、本操作单元。 */
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
  // 所有拒绝路径都在 systemd-run 派发之前（spawn 自身失败也算未派发）
  get launched() {
    return false;
  }
}

function reply(obj) {
  // 应答唯一通道：stderr 带前缀的单行 JSON（sudo 下 fd3 必然断开，见头注释）。
  // 前缀行唯一，helper 一次调用只写一次。
  fs.writeSync(2, `RUUKOTO_SERVICE_REPLY ${JSON.stringify({ v: 1, ...obj })}\n`);
}

/** 无依赖的有界等待（不引入 /bin/sleep）。 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 属主 root 且组/他人不可写的真实文件或目录（拒绝符号链接伪装）。 */
function assertRootOwned(target, what) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    throw new Refuse("deployment_invalid", `${what} 不可读：${target}（${err.message}）`);
  }
  if (st.isSymbolicLink()) throw new Refuse("deployment_invalid", `${what} 不允许是符号链接：${target}`);
  if (st.uid !== 0) throw new Refuse("deployment_invalid", `${what} 必须由 root 拥有：${target}`);
  if (st.mode & 0o022) throw new Refuse("deployment_invalid", `${what} 组/他人可写，部署不可信：${target}`);
}

/** 自身与目标路径的每一级父目录都必须 root 拥有且组/他人不可写。 */
function assertTrustedPath(target, what) {
  assertRootOwned(target, what);
  let dir = path.dirname(target);
  while (dir !== "/") {
    assertRootOwned(dir, `${what} 父目录`);
    dir = path.dirname(dir);
  }
}

const HOST_OP_ID = /^op_[0-9a-f]{24}$/;
const INSPECTION_ID = /^inspect_[0-9a-f]{24}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** restart 是否已派发 systemd（顶层 catch 决定应答的 launched 标志：派发后的
 *  失败不能报成「已知未执行」）。 */
let dispatched = false;

/** 精确规范的 .service 名：拒绝路径、空白、选项、模板实例与额外成分。 */
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
  assertTrustedPath(POLICY_PATH, "策略");
  assertTrustedPath(OPS_DIR, "操作标记目录");
  assertTrustedPath(fs.realpathSync(process.argv[1]), "helper 自身");
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
  const machineId = fs.readFileSync(MACHINE_ID_PATH, "utf8").trim();
  if (typeof policy.machineId !== "string" || policy.machineId !== machineId) {
    throw new Refuse("wrong_machine", `策略本机身份不符（策略 ${String(policy.machineId).slice(0, 12)}… ≠ 本机 ${machineId.slice(0, 12)}…）`);
  }
  if (!Number.isInteger(policy.inspectUid) || policy.inspectUid <= 0 || !Number.isInteger(policy.inspectGid) || policy.inspectGid <= 0) {
    throw new Refuse("policy_invalid", "策略的检查 UID/GID 非法");
  }
  if (typeof policy.services !== "object" || policy.services === null || Array.isArray(policy.services)) {
    throw new Refuse("policy_invalid", "策略缺少 services 清单");
  }
  for (const unit of Object.keys(policy.services)) assertWellFormedUnit(unit);
  return { policy, policyRevision: sha256Hex(raw), inspectUid: policy.inspectUid, inspectGid: policy.inspectGid };
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

const SHOW_PROPS = [
  "Id", "LoadState", "ActiveState", "SubState", "MainPID", "InvocationID", "Result",
  "ActiveEnterTimestamp", "FragmentPath", "DropInPaths", "NeedDaemonReload",
];

/** systemctl show（显式降到策略检查 UID/GID，结构化 argv，清空环境）；原始输出透传到 fd1/fd2。 */
function systemctlShow(unit, inspectUid, inspectGid) {
  const out = spawnSync(SYSTEMCTL, ["--system", "show", unit, ...SHOW_PROPS.flatMap((p) => ["--property", p])], {
    uid: inspectUid,
    gid: inspectGid,
    env: {},
    encoding: "buffer",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (out.stdout?.length) fs.writeSync(1, out.stdout);
  if (out.stderr?.length) fs.writeSync(2, out.stderr);
  if (out.error) throw new Refuse("systemd_unavailable", `systemctl 调用失败：${out.error.message}`);
  if (out.status !== 0) {
    throw new Refuse("systemctl_failed", `systemctl show 退出码 ${out.status}：${(out.stderr || Buffer.alloc(0)).toString("utf8").trim().slice(0, 200)}`);
  }
  const props = {};
  for (const line of out.stdout.toString("utf8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0 && !(line.slice(0, idx) in props)) props[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return props;
}

/** 单元修订：fragment/drop-in 的身份与内容指纹 + 已加载状态；来源不可读即拒绝。 */
function computeUnitRevision(props) {
  const files = [];
  const addFile = (p) => {
    if (!p || typeof p !== "string" || files.some((f) => f.path === p)) return;
    let content;
    try {
      content = fs.readFileSync(p);
    } catch (err) {
      throw new Refuse("revision_unreadable", `单元定义来源不可读：${p}（${err.message}）`);
    }
    files.push({ path: p, sha256: sha256Hex(content) });
  };
  addFile(props.FragmentPath);
  for (const p of (props.DropInPaths ?? "").split(" ").filter(Boolean)) addFile(p);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return sha256Hex(JSON.stringify({ files, needDaemonReload: props.NeedDaemonReload ?? "" }));
}

function inspectState(props) {
  return {
    id: props.Id ?? "",
    loadState: props.LoadState ?? "",
    activeState: props.ActiveState ?? "",
    subState: props.SubState ?? "",
    mainPid: Number(props.MainPID ?? 0) || 0,
    invocationId: props.InvocationID ?? "",
    result: props.Result ?? "",
    activeEnterTimestamp: props.ActiveEnterTimestamp ?? "",
  };
}

function cmdInspect(unit, inspectionId, expectedMachineId) {
  const { policy, policyRevision, inspectUid, inspectGid } = loadPolicy();
  if (inspectionId !== undefined) {
    assertInspectionIdentity(inspectionId, expectedMachineId, policy.machineId);
  }
  policyEntry(policy, unit);
  if (inspectionId !== undefined) {
    const launcher = launcherIdentity();
    const claimDir = path.join(OPS_DIR, inspectionId);
    claimInspection(claimDir);
    fs.writeFileSync(path.join(claimDir, "claim.json"), JSON.stringify({ version: 1, claimedBy: "inspect-op", inspectionId, machineId: policy.machineId, unit, launcher }), { mode: 0o600 });
    if (fs.existsSync(path.join(claimDir, "stop-requested"))) throw new Refuse("stop_requested", "原检查已收到停止标记；未执行检查");
  }
  const props = systemctlShow(unit, inspectUid, inspectGid);
  if (props.Id !== unit) {
    throw new Refuse("alias_refused", `目标是别名（实际单元 ${props.Id}），白名单只认精确名：${unit}`);
  }
  reply({
    verb: inspectionId === undefined ? "inspect" : "inspect-op",
    ...(inspectionId === undefined ? {} : { inspectionId }),
    ok: true,
    machineId: policy.machineId,
    policyRevision,
    unitRevision: computeUnitRevision(props),
    unit,
    state: inspectState(props),
    execIdentity: { uid: inspectUid, gid: inspectGid },
    observedAt: new Date().toISOString(),
  });
}

function opUnitFor(hostOpId) {
  return `${OP_UNIT_PREFIX}${hostOpId}.service`;
}

function launcherIdentity() {
  const fields = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").split(/\) /).at(-1).split(" ");
  return { pid: process.pid, startTime: fields[19], processGroup: Number(fields[2]), bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
}

function launcherProcessState(id) {
  const unknown = { exited: false, rebooted: false };
  if (!id || !Number.isSafeInteger(id.pid) || id.pid <= 0 || !Number.isSafeInteger(id.processGroup) || id.processGroup <= 0 || typeof id.startTime !== "string" || !/^[0-9]+$/.test(id.startTime) || typeof id.bootId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id.bootId)) return unknown;
  let bootId;
  try { bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return unknown; }
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(bootId)) return unknown;
  if (bootId !== id.bootId) return { exited: true, rebooted: true };
  let fields;
  try { fields = fs.readFileSync(`/proc/${id.pid}/stat`, "utf8").split(/\) /).at(-1).split(" "); } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ESRCH") return unknown;
  }
  if (fields && !/^[0-9]+$/.test(fields[19] ?? "")) return unknown;
  if (fields?.[19] === id.startTime) return unknown;
  // 原 helper 已退出仍可能有同组后代；持久组号只用于观察，绝不据此发停止信号。
  try { process.kill(-id.processGroup, 0); return unknown; } catch (error) { if (error.code !== "ESRCH") return unknown; }
  return { exited: true, rebooted: false };
}

function launcherState(claimDir, hostOpId, opUnit) {
  const unknown = { exited: false, missingSafe: false };
  let claim;
  try { claim = JSON.parse(fs.readFileSync(path.join(claimDir, "claim.json"), "utf8")); } catch { return unknown; }
  if (claim?.version !== 2) return unknown;
  if (claim.claimedBy === "stop-op") return { exited: true, missingSafe: true };
  if (claim.claimedBy !== "restart") return unknown;
  const id = claim.launcher;
  const observed = launcherProcessState(id);
  if (!observed.exited) return unknown;
  if (observed.rebooted) return { exited: true, missingSafe: true };
  const proof = name => {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(path.join(claimDir, name), "utf8")); } catch { return false; }
    return saved?.version === 1 && saved.hostOpId === hostOpId && saved.opUnit === opUnit && JSON.stringify(saved.launcher) === JSON.stringify(id);
  };
  return { exited: true, missingSafe: proof("launcher-completed.json") || proof("unit-observed.json") };
}

function assertInspectionIdentity(inspectionId, expectedMachineId, machineId) {
  if (!INSPECTION_ID.test(inspectionId)) throw new Refuse("inspection_invalid", "检查 ID 形态非法（须为 inspect_ + 24 位小写十六进制）");
  if (expectedMachineId !== machineId) throw new Refuse("wrong_machine", "原检查不属于本机；保留占用并核实原机器");
}

function claimInspection(claimDir) {
  try { fs.mkdirSync(claimDir, { mode: 0o700 }); } catch (error) {
    if (error.code === "EEXIST") throw new Refuse("already_claimed", "原检查 ID 已认领，拒绝再次启动");
    throw new Refuse("claim_failed", "检查身份认领失败；未启动检查");
  }
}

function inspectionExited(claimDir, inspectionId, machineId) {
  let claim;
  try { claim = JSON.parse(fs.readFileSync(path.join(claimDir, "claim.json"), "utf8")); } catch { return false; }
  if (claim?.version !== 1 || claim.inspectionId !== inspectionId || claim.machineId !== machineId) return false;
  if (claim.claimedBy === "stop-inspect") return true;
  if (claim.claimedBy !== "inspect-op" || typeof claim.unit !== "string") return false;
  try { assertWellFormedUnit(claim.unit); } catch (error) { if (error instanceof Refuse) return false; throw error; }
  return launcherProcessState(claim.launcher).exited;
}

function cmdStopInspect(inspectionId, expectedMachineId) {
  const { policy } = loadPolicy();
  assertInspectionIdentity(inspectionId, expectedMachineId, policy.machineId);
  const claimDir = path.join(OPS_DIR, inspectionId);
  let created = false;
  try { fs.mkdirSync(claimDir, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (created) fs.writeFileSync(path.join(claimDir, "claim.json"), JSON.stringify({ version: 1, claimedBy: "stop-inspect", inspectionId, machineId: policy.machineId }), { mode: 0o600 });
  fs.writeFileSync(path.join(claimDir, "stop-requested"), new Date().toISOString() + "\n", { mode: 0o600 });
  const exited = inspectionExited(claimDir, inspectionId, policy.machineId);
  reply({ verb: "stop-inspect", ok: true, machineId: policy.machineId, inspectionId, exited, ...(exited ? {} : { detail: "原检查或同组后代仍存活，或身份无法核实；保留占用并核实原执行" }) });
}

function recordUnitObserved(claimDir, hostOpId, opUnit) {
  let claim;
  try { claim = JSON.parse(fs.readFileSync(path.join(claimDir, "claim.json"), "utf8")); } catch { return; }
  if (claim?.version !== 2 || claim.claimedBy !== "restart" || !claim.launcher) return;
  fs.writeFileSync(path.join(claimDir, "unit-observed.json"), JSON.stringify({ version: 1, hostOpId, opUnit, launcher: claim.launcher }), { mode: 0o600 });
}

function cmdRestart(hostOpId, expectedPolicyRev, expectedUnitRev, unit) {
  const { policy, policyRevision, inspectUid, inspectGid } = loadPolicy();
  if (!HOST_OP_ID.test(hostOpId)) throw new Refuse("op_invalid", "操作 ID 形态非法（须为 op_ + 24 位小写十六进制）");
  if (!HEX64.test(expectedPolicyRev) || !HEX64.test(expectedUnitRev)) throw new Refuse("revision_invalid", "修订指纹形态非法");
  const entry = policyEntry(policy, unit);
  if (!entry.actions.includes("restart")) throw new Refuse("action_denied", `策略不允许对 ${unit} 执行 restart`);

  // 原子认领一次执行权：同 ID 已有标记拒绝再次启动；标记持久保留（只证明已认领）
  const claimDir = path.join(OPS_DIR, hostOpId);
  try {
    fs.mkdirSync(claimDir, { mode: 0o700 });
  } catch (err) {
    if (err.code === "EEXIST") throw new Refuse("already_claimed", `同一操作 ID 已认领过执行权，拒绝再次启动：${hostOpId}`);
    throw new Refuse("claim_failed", `执行权认领失败：${err.message}`);
  }
  const launcher = launcherIdentity();
  fs.writeFileSync(path.join(claimDir, "claim.json"), JSON.stringify({ version: 2, claimedBy: "restart", launcher, unit, expectedPolicyRev, expectedUnitRev, claimedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });

  // 停止协议先手：认领后、启动前出现 stop-requested 则拦下迟到启动
  if (fs.existsSync(path.join(claimDir, "stop-requested"))) {
    throw new Refuse("stop_requested", `操作 ${hostOpId} 已被停止协议拦下（启动前收到停止标记）`);
  }

  // 请求 systemd 前再次核实本机（loadPolicy 已查）、白名单、策略与已加载单元修订
  if (policyRevision !== expectedPolicyRev) {
    throw new Refuse("revision_mismatch", "策略修订与批准快照不符，拒绝请求 systemd");
  }
  const props = systemctlShow(unit, inspectUid, inspectGid);
  if (props.Id !== unit) throw new Refuse("alias_refused", `目标是别名（实际单元 ${props.Id}）`);
  if (computeUnitRevision(props) !== expectedUnitRev) {
    throw new Refuse("revision_mismatch", "单元定义修订与批准快照不符，拒绝请求 systemd");
  }
  if (props.NeedDaemonReload === "yes") {
    throw new Refuse("reload_required", "单元已加载配置与磁盘不一致（NeedDaemonReload=yes），拒绝请求 systemd");
  }

  const opUnit = opUnitFor(hostOpId);
  const run = spawnSync(
    SYSTEMD_RUN,
    [
      "--pipe", "--wait", "--quiet",
      "--unit", opUnit,
      "--property", "KillMode=control-group",
      "--property", `RuntimeMaxSec=${RUNTIME_MAX_SEC}`,
      SYSTEMCTL, "--system", "restart", unit,
    ],
    { env: {}, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
  );
  // 只有可证明命令根本未启动（ENOENT/EACCES/ENOTDIR 等 exec 未成功）才报未派发；
  // 其余错误（缓冲超限 ENOBUFS 等启动后的异常）与被信号杀死：systemd-run 已启动
  // 就可能已派发——不能报成零效果，也不能报成确定退出码。
  if (run.error && ["ENOENT", "EACCES", "ENOTDIR"].includes(run.error.code)) {
    throw new Refuse("systemd_unavailable", `systemd-run 不可执行，未派发 systemd：${run.error.message}`);
  }
  // 已派发：此后（透传/应答写出失败等）一律按已启动上报——不能把可能已生效的
  // restart 误报为已知未执行（顶层 catch 据此决定 launched 标志）
  dispatched = true;
  if (run.stdout?.length) fs.writeSync(1, run.stdout);
  if (run.stderr?.length) fs.writeSync(2, run.stderr);
  if (run.error) throw new Error(`systemd-run 已启动但结果不确定（spawn 错误：${run.error.message}）`);
  if (run.status === null) throw new Error(`systemd-run 已启动但被信号${run.signal ? ` ${run.signal}` : ""}结束，restart 是否完成不确定`);
  if (run.status === 0) fs.writeFileSync(path.join(claimDir, "launcher-completed.json"), JSON.stringify({ version: 1, hostOpId, opUnit, launcher }), { mode: 0o600 });
  reply({
    verb: "restart",
    ok: true,
    machineId: policy.machineId,
    hostOpId,
    opUnit,
    launched: true,
    execIdentity: "root",
    exitCode: run.status,
    observedAt: new Date().toISOString(),
  });
}

/** 派生命令单元的退出核实：LoadState/ActiveState/MainPID/ControlPID 全部确认；查询失败不得当作已退出。 */
function opUnitExited(opUnit) {
  const out = spawnSync(SYSTEMCTL, ["--system", "show", opUnit, "--property", "LoadState,ActiveState,SubState,MainPID,ControlPID"], {
    env: {},
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
  });
  if (out.error || out.status !== 0) return { exited: false, detail: out.error ? `查询失败：${out.error.message}` : `查询退出码 ${out.status}` };
  const props = {};
  for (const line of out.stdout.toString("utf8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1);
  }
  if (props.LoadState === "not-found") return { exited: true, present: false };
  if (props.LoadState !== "loaded") return { exited: false, present: false, detail: "单元加载状态无法核实" };
  const inactive = props.ActiveState === "inactive" || props.ActiveState === "failed";
  const quiet = (props.MainPID ?? "") === "0" && (props.ControlPID ?? "") === "0";
  return inactive && quiet
    ? { exited: true, present: true }
    : { exited: false, present: true, detail: `ActiveState=${props.ActiveState}/${props.SubState} MainPID=${props.MainPID} ControlPID=${props.ControlPID}` };
}

function cmdStopOp(hostOpId) {
  loadPolicy(); // 本机与部署信任验证（策略内容不用于停止协议）
  if (!HOST_OP_ID.test(hostOpId)) throw new Refuse("op_invalid", "操作 ID 形态非法");
  const claimDir = path.join(OPS_DIR, hostOpId);
  // 停止先阻止后续启动：认领目录不存在时由停止协议创建（restart 见 EEXIST 即
  // 拒绝）；已存在则写入 stop-requested，restart 在启动前发现即拦下
  let created = false;
  try { fs.mkdirSync(claimDir, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (created) fs.writeFileSync(path.join(claimDir, "claim.json"), JSON.stringify({ version: 2, claimedBy: "stop-op", claimedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.writeFileSync(path.join(claimDir, "stop-requested"), new Date().toISOString() + "\n", { mode: 0o600 });

  const opUnit = opUnitFor(hostOpId);
  if (opUnitExited(opUnit).present) recordUnitObserved(claimDir, hostOpId, opUnit);
  spawnSync(SYSTEMCTL, ["--system", "stop", opUnit], { env: {}, encoding: "buffer" }); // 未加载/未运行的错误由核实步骤兜底
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  let last = { exited: false, detail: "未经查询" };
  let launchEnded = false;
  while (Date.now() < deadline) {
    const launcher = launcherState(claimDir, hostOpId, opUnit);
    launchEnded = launcher.exited;
    last = opUnitExited(opUnit);
    if (last.present) recordUnitObserved(claimDir, hostOpId, opUnit);
    if (!launchEnded) last = { exited: false, detail: "启动器或其进程组仍存活，或认领身份无法核实" };
    else if (!last.present && !launcher.missingSafe) last = { exited: false, detail: "启动器已退出，但无法核实已发出的创建请求是否处理，保留占用" };
    if (last.exited) break;
    sleepMs(STOP_POLL_MS);
  }
  if (last.exited) {
    fs.writeFileSync(path.join(claimDir, "stopped.json"), JSON.stringify({ opUnit, stoppedAt: new Date().toISOString() }), { mode: 0o600 });
  }
  reply({ verb: "stop-op", ok: true, machineId: fs.readFileSync(MACHINE_ID_PATH, "utf8").trim(), hostOpId, opUnit, launcherExited: launchEnded, exited: last.exited, detail: last.detail });
}

function main() {
  const args = process.argv.slice(2);
  const verb = args[0];
  if (process.getuid?.() !== 0) {
    throw new Refuse("not_root", "服务管理 helper 必须以 root 运行（仅启动账户经 sudoers 调用）");
  }
  switch (verb) {
    case "inspect":
      if (args.length !== 2) throw new Refuse("usage", "用法：inspect <unit>");
      return cmdInspect(args[1]);
    case "inspect-op":
      if (args.length !== 4) throw new Refuse("usage", "用法：inspect-op <inspectionId> <machineId> <unit>");
      return cmdInspect(args[3], args[1], args[2]);
    case "stop-inspect":
      if (args.length !== 3) throw new Refuse("usage", "用法：stop-inspect <inspectionId> <machineId>");
      return cmdStopInspect(args[1], args[2]);
    case "restart":
      if (args.length !== 5) throw new Refuse("usage", "用法：restart <hostOpId> <policyRev> <unitRev> <unit>");
      return cmdRestart(args[1], args[2], args[3], args[4]);
    case "stop-op":
      if (args.length !== 2) throw new Refuse("usage", "用法：stop-op <hostOpId>");
      return cmdStopOp(args[1]);
    default:
      throw new Refuse("usage", "用法：<inspect|inspect-op|stop-inspect|restart|stop-op> …（固定协议，无自由参数）");
  }
}

try {
  main();
} catch (err) {
  if (err instanceof Refuse) {
    reply({ verb: process.argv[2] ?? "", ok: false, launched: false, reasonCode: err.reasonCode, error: err.message });
    process.exit(64);
  }
  // 非协议拒绝的意外错误：restart 已派发后按已启动上报（结果可能已生效，效果未知）
  reply({ verb: process.argv[2] ?? "", ok: false, launched: dispatched, reasonCode: "internal", error: (err && err.message) || String(err) });
  process.exit(1);
}
