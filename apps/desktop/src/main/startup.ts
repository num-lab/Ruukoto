import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DesktopError, hostEnvironment } from "./environment.ts";

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export function assertElectronStartup(packaged: boolean, executable: string, appPath: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  if (!packaged) return;
  if (args.some(arg => !/^-psn_\d+_\d+$/.test(arg)) || ["ELECTRON_RENDERER_URL", "RUUKOTO_DESKTOP_DEV_NONCE", "RUUKOTO_DESKTOP_MANAGED", "RUUKOTO_DESKTOP_MYGO_USER_DATA"].some(key => env[key] !== undefined)) throw new DesktopError("desktop_startup_rejected", "桌面启动参数不可用于正式应用；请从应用目录重新打开。");
  let bundle: string, archive: string;
  try { bundle = path.resolve(path.dirname(fs.realpathSync(executable)), "../.."); archive = fs.realpathSync(appPath); }
  catch { throw new DesktopError("desktop_integrity", "无法核实桌面程序；请重新构建应用。"); }
  if (!bundle.endsWith(".app") || archive !== path.join(bundle, "Contents/Resources/app.asar")) throw new DesktopError("desktop_integrity", "桌面程序资源位置无效；请重新构建应用。");
  // 整包核实也覆盖 ASAR 外的 node-pty，必须早于装载 Host 的原生依赖。
  try { execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { env: hostEnvironment(env), stdio: "pipe", timeout: 15000 }); }
  catch { throw new DesktopError("desktop_integrity", "桌面程序签名或资源校验失败；请重新构建应用。"); }
}
