import type { RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import type { CliProduct } from "@ruukoto/tui/cli.ts";
import { createSchedulerFamily } from "./scheduler-tools.ts";
import { createServiceFamily } from "./service-tools.ts";

const serviceEnabled = (config: RuntimeConfig) => !!config.service && (process.platform === "linux" || config.service.allowNonLinuxPlatform === true);

// Note: 见 .agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md
export const product: CliProduct = {
  runtime: {
    type: "ruukoto",
    im: true,
    scheduler: true,
    serviceEnabled,
    toolFamilies: (ctx) => {
      const svc = ctx.config.service;
      const service = svc && serviceEnabled(ctx.config) ? {
        helperPath: svc.helperPath,
        policyPath: svc.policyPath,
        useSudo: svc.useSudo ?? true,
        sudoPath: svc.sudoPath ?? "/usr/bin/sudo",
        timeouts: svc.timeouts,
      } : null;
      return [
        createSchedulerFamily({
          coreStore: ctx.store,
          sched: ctx.sched,
          scheduler: ctx.scheduler,
          sources: ctx.sources,
          target: ctx.notificationTarget,
          now: ctx.config.scheduler?.now ?? (() => Date.now()),
        }),
        createServiceFamily({ coreStore: ctx.store, artifacts: ctx.artifacts, config: service }),
      ];
    },
  },
  defaultExecution: "local",
  legacyProjectWrites: true,
  importPersonalMemories: false,
  imports: async () => {
    const m = await import("@ruukoto/channels/personal-import.ts");
    return { preview: m.previewPersonalImport, apply: m.applyPersonalImport, revert: m.revertPersonalImport, list: m.listLegacyImports, Err: m.LegacyImportError };
  },
};
