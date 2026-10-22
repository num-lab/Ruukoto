export interface PersonalProfileIdentity { directory: string; id: string }
export interface PersonalSettingsSnapshot extends Record<string, unknown> {
  product: "ruukoto";
  profile: PersonalProfileIdentity;
  online: boolean;
  revisions: { model: string; skills: string; mcp: string };
  blockers: unknown[];
  model: { config: Record<string, unknown>; credential: { state: "available" | "missing" | "unverified"; reference: string } } | null;
  lifecycle: { managedDevelopment: boolean };
}
export interface PersonalMaintenanceStatus {
  profile: PersonalProfileIdentity;
  online: boolean;
  writable: boolean;
  code: string;
  reason: string;
  lifecycle: { kind: "cli" | "systemd" | "development"; state: string; managedDevelopment: boolean; originalEnvironment: string; pid?: number };
}
export interface PersonalMaintenanceRecord {
  v: 1;
  id: string;
  profile: PersonalProfileIdentity;
  op: string;
  target: "model" | "skills" | "mcp";
  expectedRevision: string;
  requestDigest: string;
  saveAttempted: boolean;
  stage: "stopping" | "stopped" | "saving" | "saved" | "starting" | "complete";
  savedRevision?: string;
  rejected?: string;
}
export interface PersonalManagementView {
  settings: PersonalSettingsSnapshot;
  maintenance: PersonalMaintenanceStatus;
  pending: PersonalMaintenanceRecord | null;
  saved: boolean | null;
  message: string;
}
