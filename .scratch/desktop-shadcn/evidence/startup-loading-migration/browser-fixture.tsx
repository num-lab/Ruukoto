import { createRoot } from "react-dom/client";
import { App } from "/app.tsx";
import "/style.css";
import type { DesktopBridge, DesktopTarget, DesktopUpdate } from "../../../../apps/desktop/src/shared/bridge.ts";

const mode = new URLSearchParams(location.search).get("case") ?? "slow";
const listeners: Record<DesktopTarget, Set<(update: DesktopUpdate) => void>> = { code: new Set(), personal: new Set() };
const snapshot: Extract<DesktopUpdate, { type: "snapshot" }> = { type: "snapshot", instanceChanged: false, result: { seq: 0, replay: [], snapshot: { product: "ruukoto-code", projects: [], sessions: [], tasks: [], confirmations: [], artifacts: [], previews: {}, instanceId: "startup-fixture", execution: { backend: "local", note: "隔离界面夹具" }, defaultModel: { provider: "mock", id: "mock", name: "Mock", thinkingLevel: "off" }, mainSessionId: null } } };
function publish(update: DesktopUpdate) { for (const listener of listeners.code) listener(update); }
function complete() { publish(snapshot); publish({ type: "state", state: "online" }); }
document.body.dataset.fixtureCase = mode;
document.body.dataset.fixtureStartedAt = String(Date.now());
const bridge: DesktopBridge = {
  subscribe(target, listener) {
    listeners[target].add(listener);
    let timer: number | undefined;
    if (target === "personal") listener({ type: "state", state: "failed", error: { code: "personal_not_configured", outcome: "not_sent", message: "隔离 PA 未配置。" } });
    else if (mode === "sync") complete();
    else if (mode === "failed") listener({ type: "state", state: "failed", error: { code: "fixture_rejected", outcome: "rejected", message: "隔离连接失败。" } });
    else if (mode === "closed") listener({ type: "state", state: "closed", detail: "隔离连接关闭。" });
    else if (mode === "retry") listener({ type: "state", state: "reconnecting", detail: "隔离连接正在重试。" });
    else {
      listener({ type: "state", state: mode === "online-before-snapshot" ? "online" : "connecting" });
      timer = window.setTimeout(complete, 8000);
    }
    return () => { if (timer !== undefined) window.clearTimeout(timer); listeners[target].delete(listener); };
  },
  async request(_target, op) {
    if (op === "reconnect") { publish({ type: "state", state: "connecting" }); window.setTimeout(complete, 1000); return { ok: true, value: null }; }
    if (op === "list_models") return { ok: true, value: { models: [] } };
    if (op === "desktop_personal_config_read") return { ok: true, value: { host: "", controlDir: "/var/lib/ruukoto/control" } };
    return { ok: false, error: { code: "fixture_unavailable", outcome: "not_sent", message: "夹具未接入此操作。" } };
  },
  async pickFolder() { return { ok: true, value: null }; },
  async pickAttachments() { return { ok: true, value: [] }; },
  async reveal() {},
};
window.ruukoto = bridge;
createRoot(document.getElementById("root")!).render(<><App /><button style={{ position: "fixed", right: 12, bottom: 12 }} onClick={() => publish({ type: "state", state: "reconnecting", detail: "隔离连接正在重试。" })}>模拟普通断线</button></>);
