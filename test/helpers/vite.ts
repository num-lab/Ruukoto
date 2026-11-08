import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from "vite";

export type { ViteDevServer } from "vite";

// Note: See .agents/notes/implemented/testing/2026-11-07-ci-shards-and-fixtures.md
export function createServer(config: InlineConfig): Promise<ViteDevServer> {
  return createViteServer({ ...config, plugins: [config.plugins, {
    name: "test-ssr-only", enforce: "post",
    config(config) {
      // React adds client optimization inputs; clear them after its config hook for SSR-only tests.
      config.optimizeDeps = { ...config.optimizeDeps, noDiscovery: true, include: [] };
    },
  }] });
}
