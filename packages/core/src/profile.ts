export { ProfileError } from "./profile-files.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { canonicalPath, containsPath, fileExists, plainRecord, ProfileError, readPrivateJson, type PinnedDirectory } from "./profile-files.ts";

export const PROFILE_LAYOUT = "ruukoto-single-v1" as const;
export const PROFILE_ROLES = ["data", "agent", "control", "pending"] as const;
export type ProfileRole = typeof PROFILE_ROLES[number];
export const ROLE_MARKER = ".ruukoto-role.json";

export interface ProfileDirectoryOptions { dataDir?: string; agentDir?: string; controlDir?: string; pendingDir?: string }
export interface ProfileSelection {
  readonly kind: "selection";
  readonly dataDir: string;
  readonly agentDir: string;
  readonly controlDir: string;
  readonly pendingDir: string;
  readonly pins: readonly PinnedDirectory[];
}
export interface ProfilePaths {
  readonly kind: "profile";
  readonly selection: ProfileSelection;
  readonly layout: typeof PROFILE_LAYOUT;
  readonly rootDir: string;
  readonly dataDir: string;
  readonly agentDir: string;
  readonly controlDir: string;
  readonly pendingDir: string;
  readonly workspaceDir: string;
  readonly workCopyDir: string;
  readonly logsDir: string;
  readonly backendLogPath: string;
  readonly spawnLogPath: string;
  readonly devLogPath: string;
  readonly commandHistoryPath: string;
  readonly reloadStatePath: string;
  readonly tuiPendingDir: string;
  readonly desktopPendingDir: string;
  readonly desktopDraftKey: string;
  readonly socketPath: string;
  readonly instanceId: string;
  readonly preparationId: string;
  readonly controlBindingDigest: string;
}

export function selectionTuple(selection: ProfileSelection): string[] {
  return PROFILE_ROLES.map(role => selection[`${role}Dir`]);
}

export function selectProfile(overrides: ProfileDirectoryOptions = {}, env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): ProfileSelection {
  const data = canonicalPath(overrides.dataDir ?? env.RUUKOTO_DATA_DIR ?? path.join(homeDir, ".ruukoto", "data"));
  const fields = { dataDir: data.path, agentDir: "", controlDir: "", pendingDir: "" };
  const pins = [data.pin];
  for (const role of PROFILE_ROLES.slice(1)) {
    const field = `${role}Dir` as keyof ProfileDirectoryOptions;
    const result = canonicalPath(overrides[field] ?? env[`RUUKOTO_${role.toUpperCase()}_DIR`] ?? path.join(path.dirname(data.path), role));
    fields[field] = result.path;
    pins.push(result.pin);
  }
  const paths = Object.values(fields);
  for (const selected of paths) {
    let ancestor = selected;
    for (;;) {
      if (fileExists(path.join(ancestor, ROLE_MARKER))) {
        const marker = readPrivateJson(path.join(ancestor, ROLE_MARKER));
        const guidance = plainRecord(marker) && plainRecord(marker.selection) ? JSON.stringify(marker.selection) : "the original raw directory selection";
        throw new ProfileError("profile_resolved_path", `A resolved role was supplied as a raw directory: ${selected}. Use ${guidance}.`);
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  for (let a = 0; a < paths.length; a++) for (let b = a + 1; b < paths.length; b++) {
    if (containsPath(paths[a], paths[b]) || containsPath(paths[b], paths[a])) {
      throw new ProfileError("profile_role_conflict", `Raw role directories overlap: ${paths[a]} and ${paths[b]}`);
    }
    if (fileExists(paths[a]) && fileExists(paths[b])) {
      const one = fs.statSync(paths[a]), two = fs.statSync(paths[b]);
      if (one.dev === two.dev && one.ino === two.ino) throw new ProfileError("profile_role_conflict", `Raw roles alias one directory: ${paths[a]} and ${paths[b]}`);
    }
  }
  return { kind: "selection", ...fields, pins: [...new Map(pins.map(pin => [pin.path, pin])).values()] };
}

export function profileChildEnv(selection: ProfileSelection, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...base };
  delete result.RUUKOTO_PRODUCT;
  for (const key of Object.keys(result)) if (key.startsWith("RUUKOTO_CODE_")) delete result[key];
  for (const role of PROFILE_ROLES) result[`RUUKOTO_${role.toUpperCase()}_DIR`] = selection[`${role}Dir`];
  return result;
}

type ProfileStorage = Omit<ProfilePaths, "socketPath" | "instanceId" | "preparationId" | "controlBindingDigest" | "desktopDraftKey">;

export function profileStorageFromRoles(selection: ProfileSelection, rootDir: string, roles: Readonly<Record<ProfileRole, string>>): ProfileStorage {
  const logsDir = path.join(rootDir, "logs");
  return { kind: "profile", layout: PROFILE_LAYOUT, selection, rootDir,
    dataDir: roles.data, agentDir: roles.agent, controlDir: roles.control, pendingDir: roles.pending,
    workspaceDir: path.join(rootDir, "workspace"), workCopyDir: path.join(rootDir, "agent-work"), logsDir,
    backendLogPath: path.join(logsDir, "backend.log"), spawnLogPath: path.join(logsDir, "spawn.log"), devLogPath: path.join(logsDir, "dev.log"),
    commandHistoryPath: path.join(rootDir, "tui-command-history.json"), reloadStatePath: path.join(rootDir, "reload-state.json"),
    tuiPendingDir: path.join(roles.pending, "tui"), desktopPendingDir: path.join(roles.pending, "desktop") };
}

export function profileStorage(selection: ProfileSelection): ProfileStorage {
  const rawData = selection.dataDir;
  const rootDir = path.basename(rawData) === "data" ? path.join(path.dirname(rawData), "single-v1") : rawData + ".ruukoto-single-v1";
  const key = createHash("sha256").update(rawData).digest("hex");
  const rolePath = (role: ProfileRole): string => {
    const raw = selection[`${role}Dir`];
    return role === "data" || raw === canonicalPath(path.join(path.dirname(rawData), role)).path
      ? path.join(rootDir, role) : path.join(raw + ".ruukoto-single-v1", key, role);
  };
  const result = profileStorageFromRoles(selection, rootDir, { data: rolePath("data"), agent: rolePath("agent"), control: rolePath("control"), pending: rolePath("pending") });
  const roles = PROFILE_ROLES.map(role => result[`${role}Dir`]);
  for (const role of roles) for (const raw of selectionTuple(selection)) {
    if (containsPath(role, raw) || containsPath(raw, role)) throw new ProfileError("profile_role_conflict", `Fresh and predecessor paths overlap: ${role} and ${raw}`);
    if (containsPath(raw, rootDir)) throw new ProfileError("profile_role_conflict", `Generation root overlaps predecessor role: ${rootDir} and ${raw}`);
  }
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index];
    if (!role.startsWith(rootDir + path.sep) && containsPath(role, rootDir)) throw new ProfileError("profile_role_conflict", `Role contains generation root: ${role}`);
    for (const other of roles.slice(index + 1)) if (containsPath(role, other) || containsPath(other, role)) {
      throw new ProfileError("profile_role_conflict", `Resolved roles overlap: ${role} and ${other}`);
    }
    for (const work of [result.workspaceDir, result.workCopyDir]) if (containsPath(role, work) || containsPath(work, role)) {
      throw new ProfileError("profile_role_conflict", `Role overlaps work source: ${role} and ${work}`);
    }
  }
  return result;
}

export { bootstrapProfile, readProfile, verifyProfile, ensureProfileEndpoint } from "./profile-bootstrap.ts";
