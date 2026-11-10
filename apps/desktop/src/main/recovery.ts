import type { ProfilePaths } from "@ruukoto/core/profile.ts";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function socketLookupCommand(socketPath: string): string {
  return `lsof -nP -a -U -- ${shellQuote(socketPath)}`;
}
export function versionRecovery(versions: { client: number; server: number }, managed: boolean, profile: ProfilePaths): string[] {
  if (versions.client < versions.server) return ["The client version is older; rebuild with npm run desktop:build (Electron) or npm run desktop:mygo:build (MyGo) in the current repo and reopen."];
  if (managed) return ["The dev backend version is older; restart the dev launcher."];
  return [
    `The backend version is older. Current control directory: ${profile.controlDir}`,
    `Run in a terminal: ${socketLookupCommand(profile.socketPath)}`,
    "After deduping by PID there should be exactly one PID (one PID may appear on multiple lines). Run ps -o user=,command= -p <PID> and confirm it belongs to your user and is the ruukoto server process.",
    "Run kill -TERM <PID> only on the verified PID; active tasks will be recorded as interrupted. Then click \"Reconnect\" — the app starts a new backend on demand.",
    `If no listening process is found, first check the command ran successfully, then try reconnecting; if there are multiple PIDs, the command isn't the backend, or you can't verify, stop here without signaling. Check the control directory configuration and ${profile.spawnLogPath}.`,
  ];
}
