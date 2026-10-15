import * as path from "node:path";
import type { DesktopTarget } from "../shared/bridge.ts";

export function socketLookupCommand(socketPath: string): string {
  return `lsof -nP -a -U -- '${socketPath.replaceAll("'", "'\\''")}'`;
}
export function versionRecovery(target: DesktopTarget, versions: { client: number; server: number }, managed: boolean, controlDir: string): string[] {
  if (versions.client < versions.server) return ["客户端版本较旧；请在当前仓库运行 npm run desktop:build 重建应用后重新打开。"];
  if (target === "personal") return ["服务器后台版本较旧；请在服务器部署同一 commit 并重启服务后重新连接。"];
  if (managed) return ["开发后台版本较旧；请重启开发启动器。"];
  return [
    `后台版本较旧。当前控制目录：${controlDir}`,
    `在终端运行：${socketLookupCommand(path.join(controlDir, "control.sock"))}`,
    "按 PID 去重后应恰好只有一个 PID（同一个 PID 可能有多行）。运行 ps -o user=,command= -p <PID>，确认属于你自己的用户，完整命令是 ruukoto-code 的 server 进程。",
    "只对核实后的这一个 PID 运行 kill -TERM <PID>；活动任务会记为中断。然后点击“重新连接”，应用会按需拉起新后台。",
    `未查到监听进程时，先核对命令是否执行成功，再尝试重新连接；多个不同 PID、命令不是后台或无法核对时，停在这一步，不发信号。请核对控制目录配置与 ${path.join(controlDir, "spawn.log")}。`,
  ];
}
