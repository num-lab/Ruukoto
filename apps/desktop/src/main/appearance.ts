import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { DesktopAppearance } from "../shared/bridge.ts";

// Note: See .agents/notes/implemented/feature/2026-11-08-desktop-appearance.md
const filename = "desktop-preferences.json";

export function appearanceValue(value: unknown): DesktopAppearance | null {
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

// Missing, corrupt or unknown values resolve to "system"; a corrupt file is
// reported once so a lost preference cannot disappear silently.
export function loadAppearance(userData: string): DesktopAppearance {
  let raw: string;
  try { raw = fs.readFileSync(path.join(userData, filename), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`[ruukoto:desktop] desktop-preferences.json unreadable (${(error as NodeJS.ErrnoException).code ?? "unknown"}); fell back to system. Check the app data directory.\n`);
    return "system";
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const appearance = appearanceValue((value as Record<string, unknown>).appearance);
      if (appearance) return appearance;
    }
  } catch { /* fall through to the diagnostic below */ }
  process.stderr.write(`[ruukoto:desktop] desktop-preferences.json unreadable; fell back to system. Check the app data directory.\n`);
  return "system";
}

export function saveAppearance(userData: string, value: DesktopAppearance): void {
  const target = path.join(userData, filename);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify({ v: 1, appearance: value })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
