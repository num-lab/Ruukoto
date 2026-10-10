import type { CliProduct } from "@ruukoto/tui/cli.ts";
import { LegacyImportError, listLegacyImports } from "@ruukoto/core/import-support.ts";

// Note: 见 .agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md
export const product: CliProduct = {
  runtime: { type: "ruukoto-code", im: false, scheduler: false, serviceEnabled: () => false, toolFamilies: () => [] },
  defaultExecution: "container",
  legacyProjectWrites: false,
  importPersonalMemories: true,
  imports: async () => {
    const m = await import("./legacy-import.ts");
    return { preview: m.previewLegacyImport, apply: m.applyLegacyImport, revert: m.revertLegacyImport, list: listLegacyImports, Err: LegacyImportError };
  },
};
