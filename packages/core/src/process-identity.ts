import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

export function validProcessIdentity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/.test(value)) return true;
  if (!value.startsWith("darwin:")) return false;
  const date = new Date(`${value.slice(7)} UTC`);
  if (!Number.isFinite(date.getTime())) return false;
  const [weekday, day, month, year, time] = date.toUTCString().split(" ");
  return value === `darwin:${weekday!.slice(0, -1)} ${month} ${String(Number(day)).padStart(2, " ")} ${time} ${year}`;
}

export function processIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      if (end < 0) return null;
      const ticks = stat.slice(end + 1).trim().split(/\s+/)[19];
      const identity = `linux:${bootId}:${ticks}`;
      return validProcessIdentity(identity) ? identity : null;
    }
    if (process.platform === "darwin") {
      // shortcut: ps 仅秒级，同秒 PID 复用可能保守误拒；出现误拒时升级启动标识精度。
      const startedAt = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", timeout: 3_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }).trim();
      const identity = `darwin:${startedAt}`;
      return validProcessIdentity(identity) ? identity : null;
    }
    return null;
  } catch {
    return null;
  }
}
