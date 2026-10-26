export interface PersonalProfileIdentity { directory: string; id: string }
export interface PersonalSettingsSnapshot extends Record<string, unknown> {
  product: "ruukoto";
  profile: PersonalProfileIdentity;
  online: boolean;
  settingsProtocol?: 2;
  fileIssues?: { target: string; code: string; expectedRevision: string; actualRevision: string | null }[];
  effective?: { target: string; scope: string; version: string; revision: string | null }[];
  operationsNextOffset?: number;
  effectiveNextOffset?: number;
  revisionsUnknown?: string[];
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
  operations?: PersonalConfigurationReceipt[];
  operation?: PersonalConfigurationReceipt;
}

export interface PersonalConfigurationReceipt {
  v: 2;
  id: string;
  profile: PersonalProfileIdentity;
  target: "model" | "skills" | "mcp" | "web-search" | "telegram" | "qq" | "commands" | "services";
  scope: string;
  requestDigest: string;
  status: "rejected" | "saved" | "waiting" | "active" | "failed" | "unknown" | "superseded";
  savedRevision: string | null;
  effectiveRevision: string | null;
  code: string;
  relatedOperations: { kind: string; id: string }[];
  supersededBy?: string;
}

export interface PersonalCuaStatus {
  available: boolean;
  paused: boolean;
  busy: boolean;
  operations: { operation: number; service: string; tool: string; effect: string; code: string; cuaRecovery?: "frozen" | "stopped" | "begun" | "observed" | "accepted"; cuaObservation?: number; images: { id: string; mime: string; bytes: number; sha256: string }[] }[];
}

export interface PersonalMcpOperationSummary {
  operation: number;
  service: string;
  tool: string;
  effect: string;
  code: string;
  canEnd: boolean;
  ended: boolean;
  cuaRecovery?: "frozen" | "stopped" | "begun" | "observed" | "accepted";
}
