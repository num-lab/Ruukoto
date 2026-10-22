import { spawn, type ChildProcess } from "node:child_process";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { PersonalTargetConfig } from "./personal-config.ts";
import { shellQuote } from "./recovery.ts";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

const SSH_OPTIONS = ["BatchMode=yes", "ControlMaster=no", "ControlPath=none", "ControlPersist=no", "ForkAfterAuthentication=no", "RemoteCommand=none", "ConnectTimeout=10"];
const options = (values: string[]) => values.flatMap(value => ["-o", value]);
export function commandArgs(host: string, command: string): string[] {
  return [...options([...SSH_OPTIONS, "ClearAllForwardings=yes", "RequestTTY=no"]), "--", host, command];
}
export function tokenCommand(config: PersonalTargetConfig): string {
  const dir = shellQuote(config.controlDir);
  const socket = shellQuote(path.posix.join(config.controlDir, "control.sock"));
  const token = shellQuote(path.posix.join(config.controlDir, "owner.token"));
  return `test -d ${dir} || exit 10; test -x ${dir} || exit 11; test -S ${socket} || exit 12; test -w ${socket} || exit 13; test -f ${token} && test -r ${token} || exit 14; cat -- ${token}`;
}
export function tokenArgs(config: PersonalTargetConfig): string[] {
  return [...options([...SSH_OPTIONS, "ClearAllForwardings=yes", "RequestTTY=no"]), "--", config.host, tokenCommand(config)];
}
export function forwardArgs(config: PersonalTargetConfig, socketPath: string): string[] {
  return ["-N", ...options([...SSH_OPTIONS, "ExitOnForwardFailure=yes", "StreamLocalBindUnlink=yes", "ServerAliveInterval=15"]), "-L", `${socketPath}:${path.posix.join(config.controlDir, "control.sock")}`, "--", config.host];
}

const NETWORK_ERROR = /Connection timed out|Connection refused|Network is unreachable|No route to host|Could not resolve hostname|Connection (?:closed by|to [^\r\n]+ closed by remote host)|Connection reset|Broken pipe|Timeout, server [^\r\n]*not responding/;
const FORWARD_ERROR = /Could not request local forwarding|cannot listen to port|Bad (?:stream )?local forwarding specification/;
export function forwardFailure(code: number | null, stderr: string): ControlClientError | null {
  return code === 255 && FORWARD_ERROR.test(stderr) ? new ControlClientError("forward_setup_failed", `SSH 转发建立失败：${stderr.trim()}。请修复 ssh_config 中的 LocalForward，或为桌面端单独设置不带端口转发的主机别名后重新连接。`, "rejected") : null;
}
export function tokenFailure(code: number | null, stderr: string): ControlClientError {
  if (code === 12) return new ControlClientError("remote_socket_missing", "远端控制 socket 不存在；等待后台启动。", "not_sent");
  if (code === 255) return new ControlClientError(NETWORK_ERROR.test(stderr) ? "ssh_network" : "ssh_rejected", `SSH 连接失败：${stderr.trim() || "未提供诊断"}。请核对主机别名、密钥或 ssh-agent 与主机密钥后重新连接。`, NETWORK_ERROR.test(stderr) ? "not_sent" : "rejected");
  const reasons: Record<number, string> = { 10: "远端控制目录不存在", 11: "远端控制目录不可进入", 13: "远端控制 socket 不可写", 14: "远端 owner.token 不是可读的普通文件" };
  return new ControlClientError("remote_control_unavailable", `${code === null ? "远端令牌读取中断" : reasons[code] ?? "远端令牌读取失败"}；请核对控制目录配置，并采用 SSH 登录账户与后台账户相同的部署后重新连接。`, "rejected");
}

// 只管理本次 spawn 的进程；等待 close 才允许复用本地 socket。
export class SshProcess {
  readonly child: ChildProcess;
  readonly done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  private exited = false;
  private stopping: Promise<void> | null = null;
  constructor(executable: string, args: string[], env: NodeJS.ProcessEnv, read: boolean, input?: string, outputLimit = 65536) {
    this.child = spawn(executable, args, { env: { ...env, LC_ALL: "C" }, stdio: [input === undefined ? "ignore" : "pipe", read ? "pipe" : "ignore", "pipe"] });
    this.child.stdin?.on("error", () => { /* SSH 先退出时的 EPIPE 由 close 结果统一报告。 */ });
    this.child.stdin?.end(input);
    this.done = new Promise((resolve, reject) => {
      let stdout = "", stderr = "", spawnError = false, overflow = false, bytes = 0;
      const decoder = new StringDecoder("utf8");
      this.child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > outputLimit) { overflow = true; void this.stop(); }
        else stdout += decoder.write(chunk);
      });
      this.child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
      this.child.on("error", () => { spawnError = true; });
      this.child.on("close", code => {
        this.exited = true;
        stdout += decoder.end();
        if (spawnError) reject(new ControlClientError("ssh_unavailable", "无法启动 ssh；请确认登录环境中已安装可执行的 OpenSSH 后重新连接。", "rejected"));
        else if (overflow) reject(new ControlClientError("ssh_output_limit", "远端令牌输出过大；请核对 owner.token 与远端 shell 启动输出后重新连接。", "rejected"));
        else resolve({ code, stdout, stderr });
      });
    });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.exited) return;
      this.child.kill("SIGTERM");
      const kill = setTimeout(() => { if (!this.exited) this.child.kill("SIGKILL"); }, 2000);
      try { await this.done; }
      catch { /* 读取/转发调用方报告启动与输出失败；这里只等待进程回收。 */ }
      finally { clearTimeout(kill); }
    })();
    return this.stopping;
  }
}
