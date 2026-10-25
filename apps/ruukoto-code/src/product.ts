import type { CliProduct } from "@ruukoto/tui/cli.ts";
import { LegacyImportError, listLegacyImports } from "@ruukoto/core/import-support.ts";

// Note: 见 .agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md
// Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
export const product: CliProduct = {
  runtime: { type: "ruukoto-code", branchSessions: true, manualCompaction: true, im: false, scheduler: false, codeScheduler: true, serviceEnabled: () => false, toolFamilies: () => [] },
  defaultExecution: "native",
  allowedExecution: ["native"],
  legacyProjectWrites: false,
  importPersonalMemories: true,
  imports: async () => {
    const m = await import("./legacy-import.ts");
    return { preview: m.previewLegacyImport, apply: m.applyLegacyImport, revert: m.revertLegacyImport, list: listLegacyImports, Err: LegacyImportError };
  },
};
