import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";

type Credential = { name: string; host: string; header: string; purpose: string; references: unknown[] };
// Matches WEB_SEARCH_CREDENTIAL_NAME in @ruukoto/agent web-search.ts: the desktop-only op only writes this fixed-name binding.
const WEB_SEARCH_CREDENTIAL_NAME = "web-search";
const TAVILY_CREDENTIAL_PURPOSE = "tavily_search";

/** Web search page: instant actions, no draft; re-read to verify after writes, whole page rebuilds on instance switch. */
export class CodeWebSearchState {
  phase: "loading" | "ready" | "error" = "loading";
  reading = false;
  writing = false;
  message = "";
  fieldErrors: Record<string, string> = {};
  credentials: Credential[] = [];
  secret = "";
  private generation = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void, readonly instanceId: string, private readonly context: () => { instanceId: string | null; online: boolean }) {}
  /** The server-side resolveCredential takes the first by name order; keep the same order here to show the effective credential. */
  get effective(): Credential | null { return this.credentials.slice().sort((a, b) => a.name.localeCompare(b.name))[0] ?? null; }
  get desktopManaged(): boolean { return this.credentials.some(credential => credential.name === WEB_SEARCH_CREDENTIAL_NAME); }
  get connected(): boolean { const current = this.context(); return current.online && current.instanceId === this.instanceId; }
  get disabled(): boolean { const current = this.context(); return this.reading || this.writing || !current.online || current.instanceId !== this.instanceId; }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<DesktopResult<T>> {
    try { return await this.bridge.request("code", op, params) as DesktopResult<T>; }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "No host response. Restore the original connection and read the configuration again." } }; }
  }
  private accepts(generation: number): boolean { const current = this.context(); return generation === this.generation && current.online && current.instanceId === this.instanceId; }
  invalidate(): void { ++this.generation; this.secret = ""; this.reading = false; this.writing = false; }
  async read(): Promise<boolean> {
    if (this.reading || this.writing) return false;
    const generation = ++this.generation;
    this.reading = true; this.changed();
    const result = await this.request<Credential[]>("list_credentials", { purpose: TAVILY_CREDENTIAL_PURPOSE });
    if (!this.accepts(generation)) return false;
    this.reading = false;
    if (!result.ok) { this.phase = "error"; this.message = result.error.message + " Read it again."; this.changed(); return false; }
    this.credentials = result.value;
    this.phase = "ready"; this.message = ""; this.changed();
    return true;
  }
  editSecret(value: string): void { this.secret = value; delete this.fieldErrors.secret; this.changed(); }
  async saveSecret(): Promise<boolean> {
    if (this.disabled) return false;
    this.fieldErrors = {};
    if (!this.secret || this.secret !== this.secret.trim() || /[\r\n]/.test(this.secret)) { this.fieldErrors.secret = "Enter a Tavily API key without leading/trailing whitespace or newlines."; this.changed(); return false; }
    return this.write("web_search_save_credential", { secret: this.secret }, "Tavily credential saved.");
  }
  async removeCredential(): Promise<boolean> {
    if (this.disabled) return false;
    return this.write("web_search_remove_credential", {}, "Tavily credential removed.");
  }
  async setWebSearch(enabled: boolean, expectedVersion: number): Promise<boolean> {
    if (this.disabled) return false;
    return this.write("set_web_search", { enabled, expected_version: expectedVersion }, `Web search ${enabled ? "enabled" : "disabled"}.`, false);
  }
  /** Re-read to verify after writes; on unknown outcome keep the original notice and require a re-read — never auto-resend. */
  private async write(op: string, params: Record<string, unknown>, doneMessage: string, clearSecret = true): Promise<boolean> {
    const generation = this.generation;
    this.writing = true; this.message = ""; this.changed();
    const request = this.request(op, params);
    if (clearSecret) this.secret = "";
    const result = await request;
    if (!this.accepts(generation)) return false;
    this.writing = false;
    if (!result.ok) {
      const unknown = result.error.outcome === "unknown" || result.error.outcome === "disconnected";
      this.message = unknown ? `Outcome unverified (${result.error.message}); read it again. It won't be resent automatically.` : result.error.code === "version_conflict" ? "The project setting was changed by another client. Choose again with the current value." : result.error.message;
      this.phase = "ready"; this.changed();
      if (unknown) { const read = await this.read(); if (read) { this.message = "The operation outcome was unknown; the current configuration was read back. Check whether it took effect."; this.changed(); } }
      return false;
    }
    const read = await this.read();
    this.message = read ? doneMessage : `${doneMessage} Reading back failed; read again to verify.`;
    this.changed();
    return true;
  }
}
