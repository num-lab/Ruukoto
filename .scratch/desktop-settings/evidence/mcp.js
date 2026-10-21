// 合成 renderer bridge：只验证页面交互与布局，不作为真实 MCP 或双外壳验收。
const workspace = { id: 'workspace', name: '桌面开发', rootDir: { cwd: '/fixture', cwdReal: '/fixture', dev: 1, ino: 1 }, instructionFiles: [], settingsVersion: 1, webSearch: 'enabled', createdAt: '2026-10-21' };
const legacy = { ...workspace, id: 'legacy', name: '旧项目配置', rootDir: null };
let services = [];
let credentials = [];
let seq = 0;
window.mcpFixture = { requests: [], loseNext: false, state: () => ({ services, credentials }) };
const snapshot = { product: 'ruukoto-code', projects: [workspace, legacy], sessions: [], tasks: [], confirmations: [], artifacts: [], previews: {}, instanceId: 'synthetic-mcp-settings', execution: { backend: 'local', note: 'renderer fixture' }, defaultModel: { provider: 'mock', id: 'mock', name: 'Mock', thinkingLevel: 'off' }, mainSessionId: null };
const ok = value => ({ ok: true, value });
const fail = (code, message, outcome = 'rejected') => ({ ok: false, error: { code, outcome, message } });
window.ruukoto = {
  subscribe(target, receive) {
    setTimeout(() => { receive({ type: 'state', state: target === 'code' ? 'online' : 'closed' }); if (target === 'code') receive({ type: 'snapshot', instanceChanged: false, result: { snapshot, replay: [], seq: 0 } }); }, 20);
    return () => {};
  },
  async request(target, op, params) {
    window.mcpFixture.requests.push({ target, op });
    if (op === 'list_session_summaries' || op === 'desktop_pending_read') return ok([]);
    if (op === 'list_models') return ok({ models: [], nextOffset: null });
    if (op === 'mcp_sources') return ok({ sources: [workspace, legacy].map(source => ({ projectId: source.id, name: source.name, isWorkspace: source.id === workspace.id, serviceCount: services.filter(service => service.projectId === source.id).length })), offset: 0, hasMore: false });
    if (op === 'mcp_list') return ok({ services: services.filter(service => service.projectId === params.project_id).map(service => ({ ...service })) });
    if (op === 'list_credentials') return ok(credentials.map(credential => ({ ...credential, references: services.filter(service => service.credential === credential.name).map(service => ({ serviceId: service.id, projectId: service.projectId, projectName: '桌面开发', serviceName: service.name })) })));
    if (op === 'mcp_save_credential') { const credential = { name: params.name, host: new URL(params.endpoint).host, purpose: 'mcp', header: 'authorization', scope: { projectId: params.project_id, operations: ['mcp'] }, references: [] }; credentials.push(credential); return ok(credential); }
    if (op === 'mcp_remove_credential') { credentials = credentials.filter(credential => credential.name !== params.name); return ok({ removed: true }); }
    if (op === 'mcp_configure') {
      const current = services.find(service => service.projectId === params.project_id && service.name === params.name);
      if ((current?.configVersion ?? 0) !== params.expected_version) return fail('version_conflict', '合成版本冲突，请读回当前值。');
      const service = { ...current, id: current?.id ?? 'service-' + ++seq, projectId: params.project_id, name: params.name, endpoint: new URL(params.endpoint).href, credential: params.credential === undefined ? current?.credential ?? null : params.credential, enabled: params.enabled, toolAllowlist: params.tool_allowlist.map(tool => ({ ...tool })), configVersion: (current?.configVersion ?? 0) + 1, createdAt: '2026-10-21', updatedAt: '2026-10-21' };
      services = [...services.filter(item => item.id !== service.id), service];
      if (window.mcpFixture.loseNext) { window.mcpFixture.loseNext = false; return fail('request_timeout', '合成丢答', 'unknown'); }
      return ok(service);
    }
    if (op === 'mcp_set_enabled') { const service = services.find(service => service.id === params.service_id); service.enabled = params.enabled; service.configVersion++; return ok({ ...service }); }
    if (op === 'mcp_remove') { services = services.filter(service => service.id !== params.service_id); return ok({ removed: true }); }
    if (op === 'mcp_check') { const service = services.find(service => service.id === params.service_id); return ok({ service: { ...service }, ok: true, serverInfo: { name: '合成 MCP' }, protocolVersion: '2025-06-18', tools: ['read_docs', 'publish_note'].map(name => ({ name, allowed: false, reason: '不在允许列表' })) }); }
    return fail('fixture_unavailable', '合成 bridge 未提供此操作。', 'not_sent');
  },
  async pickFolder() { return ok(null); }
};
await import('/apps/desktop/src/renderer/main.tsx');
