let config = { host: 'pa-test', controlDir: '/control' };
window.settingsRequests = [];
const snapshot = { product: 'ruukoto-code', projects: [], sessions: [], tasks: [], confirmations: [], artifacts: [], previews: {}, instanceId: 'synthetic-settings', execution: { backend: 'local', note: 'renderer fixture' }, defaultModel: { provider: 'mock', id: 'mock', name: 'Mock', thinkingLevel: 'off' }, mainSessionId: null };
window.ruukoto = {
  subscribe(target, receive) {
    setTimeout(() => { receive({ type: 'state', state: target === 'code' ? 'online' : 'closed' }); if (target === 'code') receive({ type: 'snapshot', instanceChanged: false, result: { snapshot, replay: [], seq: 0 } }); }, 20);
    return () => {};
  },
  async request(target, op, params) {
    window.settingsRequests.push({ target, op, params });
    if (op === 'desktop_personal_config_read') return { ok: true, value: { ...config } };
    if (op === 'desktop_personal_config_save') { config = { ...params }; return { ok: true, value: { ...config } }; }
    if (op === 'list_session_summaries') return { ok: true, value: [] };
    if (op === 'desktop_pending_read') return { ok: true, value: [] };
    if (op === 'list_models') return { ok: true, value: { models: [], nextOffset: null } };
    return { ok: false, error: { code: 'fixture_unavailable', outcome: 'not_sent', message: '合成 bridge 未提供此操作。' } };
  },
  async pickFolder() { return { ok: true, value: null }; }
};
await import('/apps/desktop/src/renderer/main.tsx');
