import * as fs from "node:fs";
import * as path from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import childProcess from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentity } from "@ruukoto/core/process-identity.ts";
import { PersonalError } from "./personal-error.ts";
import { personalControl } from "./personal-control.ts";
import { lockPersonalProfile } from "./personal-profile.ts";
import { assertPersonalSettingsIdle, dispatchPersonalSettings, PERSONAL_SETTINGS_LIMITS, personalSettingsIdentity, type PersonalSettingsIdentity } from "./personal-settings.ts";

const UNIT = "ruukoto-backend.service";
const SYSTEMCTL = "/usr/bin/systemctl";
const SUDO = "/usr/bin/sudo";
const PROPERTIES = "Id,LoadState,ActiveState,SubState,MainPID,User,ExecStart,SendSIGKILL,KillMode,KillSignal,TimeoutStopFailureMode,NeedDaemonReload,Type,RefuseManualStart,RefuseManualStop,ExecStop,ExecStopPost";
export type PersonalMaintenanceRequest = { v: 1; op: "inspect" | "stop" | "start"; lifecycle: "cli" | "systemd" | "development"; program: string; profile?: PersonalSettingsIdentity };
type Lifecycle = { kind: PersonalMaintenanceRequest["lifecycle"]; state: "running" | "stopped" | "unknown"; pid?: number; managedDevelopment: boolean; originalEnvironment: "unverified"; processIdentity?: string };
export type PersonalMaintenanceResult = { profile: PersonalSettingsIdentity; online: boolean; writable: boolean; code: string; reason: string; lifecycle: Lifecycle };
type SettingsStatus = { product: string; profile: PersonalSettingsIdentity; online: boolean; lifecycle: { state: string; pid?: number; managedDevelopment: boolean }; blockers?: unknown[] };
const unavailable = (code: string, message: string) => new PersonalError(code, message);
const absolutePath = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) && path.resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value);

export function parsePersonalMaintenanceRequest(value: unknown): PersonalMaintenanceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("v" in value) || value.v !== 1 || !("op" in value) || !["inspect", "stop", "start"].includes(String(value.op)) || !("lifecycle" in value) || !["cli", "systemd", "development"].includes(String(value.lifecycle)) || !("program" in value) || !absolutePath(value.program) || Object.keys(value).some(key => !["v", "op", "lifecycle", "program", "profile"].includes(key))) throw unavailable("maintenance_request_invalid", "维护请求无效，请更新桌面客户端并重新连接原个人档案。");
  if ("profile" in value) {
    const profile = value.profile;
    if (!profile || typeof profile !== "object" || Array.isArray(profile) || Object.keys(profile).sort().join(",") !== "directory,id" || !("directory" in profile) || !absolutePath(profile.directory) || !("id" in profile) || typeof profile.id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(profile.id)) throw unavailable("maintenance_request_invalid", "档案身份无效，请重新读取原个人档案。");
  } else if (value.op !== "inspect") throw unavailable("maintenance_request_invalid", "启动与停止必须关联原档案，请重新读取后操作。");
  return value as PersonalMaintenanceRequest;
}

async function command(executable: string, args: string[], timeout = 5000): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, args, { env: { ...process.env, LC_ALL: "C", SYSTEMD_PAGER: "", SYSTEMD_COLORS: "0" }, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "", bytes = 0, failure: PersonalError | undefined;
    const decoder = new StringDecoder("utf8");
    let reap: ReturnType<typeof setTimeout> | undefined;
    const stopClient = () => {
      child.kill("SIGTERM");
      // 只回收本次 systemctl / sudo 客户端，不向后台或服务进程组发信号。
      reap ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(() => { failure = unavailable("maintenance_result_unverified", "原服务操作超时，结果待核实；请重新连接查询服务与档案状态，勿重复操作。"); stopClient(); }, timeout);
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) { failure = unavailable("maintenance_output_large", "服务查询输出超限，结果待核实；请保留原服务并检查部署。"); stopClient(); }
      else stdout += decoder.write(chunk);
    });
    child.on("error", () => { failure = unavailable("maintenance_command_unavailable", "服务管理程序不可用，请管理员核实系统级服务与精确 start/stop 授权。"); });
    child.on("close", code => { clearTimeout(timer); clearTimeout(reap); stdout += decoder.end(); if (failure) reject(failure); else resolve({ code, stdout }); });
  });
}

async function unitProperties(): Promise<Record<string, string>> {
  const response = await command(SYSTEMCTL, ["show", UNIT, `--property=${PROPERTIES}`]);
  if (response.code !== 0) throw unavailable("maintenance_systemd_unavailable", "无法核实原系统级服务，请管理员检查固定 ruukoto-backend.service；设置保持只读。");
  const properties: Record<string, string> = {};
  for (const line of response.stdout.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1 || line.slice(0, separator) in properties) throw unavailable("maintenance_unit_invalid", "服务信息无法核实，请管理员检查固定单元后重新连接。");
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

export function validatePersonalMaintenanceUnit(properties: Record<string, string>, expected: { program: string; directory: string; node: string; user: string; uid: number }): void {
  if (properties.Id !== UNIT || properties.LoadState !== "loaded" || properties.NeedDaemonReload !== "no" || properties.Type !== "simple" || properties.RefuseManualStart !== "no" || properties.RefuseManualStop !== "no") throw unavailable("maintenance_unit_invalid", "系统级固定服务未正确加载或不支持手动启停，请管理员核实单元并 daemon-reload；设置保持只读。");
  // systemctl show 对空的命令数组不输出属性，即使传了 --all。
  if (properties.SendSIGKILL !== "no" || properties.TimeoutStopFailureMode !== "terminate" || properties.KillMode !== "control-group" || !["15", "SIGTERM"].includes(properties.KillSignal) || (properties.ExecStop ?? "") !== "" || (properties.ExecStopPost ?? "") !== "") throw unavailable("maintenance_force_kill_enabled", "原服务未配置安全优雅停止，请管理员设置 SendSIGKILL=no、TimeoutStopFailureMode=terminate、KillMode=control-group 与 KillSignal=SIGTERM；设置保持只读。");
  if (![expected.user, String(expected.uid)].includes(properties.User)) throw unavailable("maintenance_account_mismatch", "服务运行账户与 SSH 账户不同，请选择同账户的受支持部署；设置保持只读。");
  const execution = properties.ExecStart?.match(/^\{ path=([^;]+?) ; argv\[\]=([^;]+?) ; ignore_errors=no ; /);
  let matched = false;
  if (execution && properties.ExecStart.indexOf("{", 1) === -1 && execution[2].startsWith(`${execution[1]} `)) {
    const args = execution[2].slice(execution[1].length + 1).match(/^(.*?) serve --directory (.*)$/);
    try { matched = !!args && fs.realpathSync(execution[1]) === expected.node && fs.realpathSync(args[1]) === fs.realpathSync(expected.program) && fs.realpathSync(args[2]) === expected.directory; }
    catch { /* 无法解析的单元路径保持只读，不根据猜测启动其他档案。 */ }
  }
  if (!matched) throw unavailable("maintenance_entry_mismatch", "服务入口或档案参数不匹配，请管理员使用固定 Node 与程序入口及 serve --directory 绝对档案路径；设置保持只读。");
}

async function status(directory: string): Promise<SettingsStatus> {
  try {
    const lifecycle = await personalControl<SettingsStatus>(directory, "POST", "/settings", { v: 1, op: "lifecycle.status" }, 5000);
    if (!lifecycle || lifecycle.product !== "ruukoto" || lifecycle.online !== true || !lifecycle.profile || !absolutePath(lifecycle.profile.directory) || !/^sha256:[0-9a-f]{64}$/.test(lifecycle.profile.id) || !lifecycle.lifecycle || typeof lifecycle.lifecycle.managedDevelopment !== "boolean" || lifecycle.lifecycle.state !== "running" || !Number.isSafeInteger(lifecycle.lifecycle.pid) || Number(lifecycle.lifecycle.pid) < 1) throw unavailable("maintenance_protocol_invalid", "原后台不提供受支持的维护身份，请升级程序后重新连接。");
    return lifecycle;
  } catch (error) {
    if (!(error instanceof PersonalError) || !["control_unavailable", "control_response_lost"].includes(error.code)) throw error;
  }
  const profile = lockPersonalProfile(directory);
  try { return await dispatchPersonalSettings({ profile }, { v: 1, op: "lifecycle.status" }) as SettingsStatus; }
  finally { profile.release(); }
}

function sameProfile(expected: PersonalSettingsIdentity, actual: PersonalSettingsIdentity): void {
  if (!isDeepStrictEqual(expected, actual)) throw unavailable("maintenance_profile_changed", "个人档案身份已变化，未启动或停止其他实例；请重新选择原档案。");
}

function verifyProcess(pid: number, request: PersonalMaintenanceRequest, directory: string): string {
  const identity = processIdentity(pid);
  if (!identity) throw unavailable("maintenance_process_unverified", "原后台进程身份无法核实，请保留服务与档案并重新连接。");
  let argv: string[], uid: number, executable: string;
  try {
    argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    uid = Number(fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1]);
    executable = fs.realpathSync(`/proc/${pid}/exe`);
  } catch (error) { throw unavailable("maintenance_process_unverified", "原后台执行账户或入口无法核实，请保留服务并检查同账户部署。"); }
  if (uid !== process.getuid?.() || executable !== fs.realpathSync(process.execPath) || argv.length !== 5 || fs.realpathSync(argv[1]) !== fs.realpathSync(request.program) || argv[2] !== "serve" || argv[3] !== "--directory" || fs.realpathSync(argv[4]) !== directory || processIdentity(pid) !== identity) throw unavailable("maintenance_process_mismatch", "所选服务与实际个人后台的账户、入口或档案不匹配，未接管生命周期。");
  return identity;
}

async function inspect(directory: string, request: PersonalMaintenanceRequest): Promise<{ result: PersonalMaintenanceResult; unit?: Record<string, string> }> {
  const current = await status(directory);
  const canonicalDirectory = fs.realpathSync(directory);
  if (current.profile.directory !== canonicalDirectory) throw unavailable("maintenance_profile_changed", "后台档案与所选目录不一致，请重新选择原个人档案。");
  if (request.profile) sameProfile(request.profile, current.profile);
  const development = current.lifecycle.managedDevelopment || request.lifecycle === "development";
  const result: PersonalMaintenanceResult = { profile: current.profile, online: current.online, writable: false, code: "maintenance_environment_unverified", reason: "原 CLI 启动环境无法核实；请管理员按部署说明配置固定 systemd 服务与精确启停授权后重新连接。", lifecycle: { kind: request.lifecycle, state: current.online ? "running" : "stopped", ...(current.online ? { pid: current.lifecycle.pid } : {}), managedDevelopment: development, originalEnvironment: "unverified" } };
  if (development) return { result: { ...result, code: "maintenance_development_readonly", reason: "开发受管实例由开发入口管理，请退出开发入口后调整配置；桌面设置保持只读。" } };
  if (request.lifecycle !== "systemd") return { result };
  try {
    if (process.platform !== "linux") throw unavailable("maintenance_systemd_unavailable", "此维护方式需要 Linux 系统级固定服务；请管理员按部署说明配置后重新连接。");
    const properties = await unitProperties();
    validatePersonalMaintenanceUnit(properties, { program: request.program, directory: canonicalDirectory, node: fs.realpathSync(process.execPath), user: userInfo().username, uid: process.getuid!() });
    if (current.online) {
      if (properties.ActiveState !== "active" || properties.SubState !== "running" || Number(properties.MainPID) !== current.lifecycle.pid) throw unavailable("maintenance_service_mismatch", "固定服务与控制后台不属于同一运行实例，请核对档案与服务；设置保持只读。");
      result.lifecycle.processIdentity = verifyProcess(current.lifecycle.pid!, request, canonicalDirectory);
    } else if (!["inactive", "failed"].includes(properties.ActiveState) || properties.MainPID !== "0") throw unavailable("maintenance_stop_unverified", "服务尚未确认退出，档案保持不变；请核实原服务与档案锁后重新连接。");
    for (const action of ["start", "stop"]) if ((await command(SUDO, ["-n", "-l", SYSTEMCTL, action, UNIT])).code !== 0) throw unavailable("maintenance_authorization_missing", "缺少固定服务的非交互 start/stop 授权，请管理员安装精确 sudoers 规则后重新连接；设置保持只读。");
    result.writable = true; result.code = "maintenance_ready"; result.reason = current.online ? "已核实原系统级服务；保存前仍需检查实际后台凭据与未决事项。" : "已核实停止的系统级服务；可显式恢复启动，原服务凭据环境尚未验证。";
    return { result, unit: properties };
  } catch (error) {
    if (!(error instanceof PersonalError)) throw error;
    return { result: { ...result, code: error.code, reason: error.message, lifecycle: { ...result.lifecycle, state: current.online ? "running" : "unknown" } } };
  }
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-settings-ssh.md
export async function executePersonalMaintenance(directory: string, value: unknown): Promise<PersonalMaintenanceResult> {
  const request = parsePersonalMaintenanceRequest(value);
  if (!fs.existsSync(path.join(directory, "profile.json"))) throw unavailable("maintenance_profile_missing", "所选个人档案不存在，请选择已经配置的新 durable 档案；未创建其他实例。");
  directory = fs.realpathSync(directory);
  if (fs.realpathSync(request.program) !== fs.realpathSync(fileURLToPath(new URL("../bin/ruukoto.mjs", import.meta.url)))) throw unavailable("maintenance_program_mismatch", "所选维护程序与当前程序不一致，请检测并重新选择新 durable 程序入口。");
  const checked = await inspect(directory, request), before = checked.result;
  if (request.op === "inspect") return before;
  if (!before.writable) throw unavailable(before.code, before.reason);
  if (request.op === "stop") {
    if (!before.online) throw unavailable("maintenance_already_stopped", "原服务已经停止，请读取原操作结果后决定恢复启动；未重放停止。");
    const settings = await personalControl<SettingsStatus>(directory, "POST", "/settings", { v: 1, op: "settings.read", limit: 1 }, 5000);
    sameProfile(before.profile, settings.profile);
    if (!Array.isArray(settings.blockers) || settings.blockers.length) throw unavailable("settings_pending", "仍有未决输入、工作或未知外部占用，未停止服务；请先用原配置处理。");
    const latest = await inspect(directory, request);
    if (!latest.result.writable || latest.result.lifecycle.processIdentity !== before.lifecycle.processIdentity) throw unavailable("maintenance_service_changed", "原服务在预检后变化，未停止；请重新连接并读取原配置。");
  } else {
    if (before.online) throw unavailable("maintenance_already_running", "原服务已经运行，请读取配置核实生效结果；未重放启动。");
    const profile = lockPersonalProfile(directory);
    try { sameProfile(before.profile, personalSettingsIdentity(profile)); }
    finally { profile.release(); }
  }
  const response = await command(SUDO, ["-n", SYSTEMCTL, request.op, UNIT], 40_000);
  if (response.code !== 0) throw unavailable(`maintenance_${request.op}_unverified`, request.op === "stop" ? "停止未核实，未保存设置；请查询原服务与档案锁，不要重复停存启或强杀。" : "原服务启动未核实，已保存事实保持；请查询原服务与配置，再显式决定恢复。");
  for (let attempt = 0; attempt < 25; attempt++) {
    const properties = await unitProperties();
    if (request.op === "stop" && properties.ActiveState === "inactive" && properties.MainPID === "0") {
      const original = processIdentity(before.lifecycle.pid!);
      if (original === before.lifecycle.processIdentity || !original && fs.existsSync(`/proc/${before.lifecycle.pid}/stat`)) throw unavailable("maintenance_stop_unverified", "原后台进程尚未确认退出，未保存；请保留原进程与档案锁并核实服务。");
      const profile = lockPersonalProfile(directory);
      try { sameProfile(before.profile, personalSettingsIdentity(profile)); await assertPersonalSettingsIdle(profile); }
      finally { profile.release(); }
      return { ...before, online: false, lifecycle: { ...before.lifecycle, state: "stopped", pid: undefined, processIdentity: undefined }, code: "maintenance_stopped", reason: "原监督服务已停止并核实档案锁；尚未保存设置，可显式恢复原启动。" };
    }
    if (request.op === "start" && properties.ActiveState === "active") {
      let after: Awaited<ReturnType<typeof inspect>> | undefined;
      try { after = await inspect(directory, request); }
      catch (error) { if (!(error instanceof PersonalError) || !["profile_busy", "control_starting"].includes(error.code)) throw error; }
      if (after?.result.online && after.result.writable) return { ...after.result, code: "maintenance_started", reason: "原服务已启动；请读回实际配置与凭据状态核实生效。" };
    }
    await delay(200);
  }
  throw unavailable(`maintenance_${request.op}_unverified`, "原服务与档案锁状态仍待核实；请重新连接查询原操作，未重放或强制结束进程。");
}

export async function runPersonalMaintenanceMachine(directory: string, input: AsyncIterable<Buffer | string>, write: (value: string) => void): Promise<number> {
  let response: unknown, status = 0;
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of input) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > PERSONAL_SETTINGS_LIMITS.requestBytes) throw unavailable("maintenance_request_large", "维护请求过大，请更新客户端并重新读取原操作状态。"); chunks.push(buffer); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw unavailable("maintenance_request_invalid", "维护请求格式无效，请更新客户端并重新连接原档案。"); }
    response = { v: 1, product: "ruukoto", ok: true, result: await executePersonalMaintenance(directory, value) };
  } catch (error) { status = 1; response = { v: 1, product: "ruukoto", ok: false, code: error instanceof PersonalError ? error.code : "maintenance_internal", message: error instanceof PersonalError ? error.message : "原服务状态无法核实，请保留档案并重新连接查询；未自动重放操作。" }; }
  write(JSON.stringify(response) + "\n");
  return status;
}
