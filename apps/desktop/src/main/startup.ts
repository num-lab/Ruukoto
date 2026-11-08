import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DesktopError, hostEnvironment } from "./environment.ts";

// Note: See .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export function assertElectronStartup(packaged: boolean, executable: string, appPath: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  if (!packaged) return;
  if (args.some(arg => !/^-psn_\d+_\d+$/.test(arg)) || ["ELECTRON_RENDERER_URL", "RUUKOTO_DESKTOP_DEV_NONCE", "RUUKOTO_DESKTOP_MANAGED", "RUUKOTO_DESKTOP_MYGO_USER_DATA"].some(key => env[key] !== undefined)) throw new DesktopError("desktop_startup_rejected", "Desktop launch arguments aren't valid for the production app; reopen it from the app directory.");
  let bundle: string, archive: string;
  try { bundle = path.resolve(path.dirname(fs.realpathSync(executable)), "../.."); archive = fs.realpathSync(appPath); }
  catch { throw new DesktopError("desktop_integrity", "The desktop program can't be verified; rebuild the app."); }
  if (!bundle.endsWith(".app") || archive !== path.join(bundle, "Contents/Resources/app.asar")) throw new DesktopError("desktop_integrity", "The desktop program's resource location is invalid; rebuild the app.");
  // The whole-bundle check also covers node-pty outside the ASAR; it must run before loading the host's native dependency.
  try { execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { env: hostEnvironment(env), stdio: "pipe", timeout: 15000 }); }
  catch { throw new DesktopError("desktop_integrity", "The desktop program's signature or resource check failed; rebuild the app."); }
}
