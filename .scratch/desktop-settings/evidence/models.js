const selection = { provider: 'mock', modelId: 'mock-model', thinkingLevel: 'off' };
let view = {
  revision: 'synthetic-1',
  providers: { mock: { name: '本机测试提供方', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: true, headers: { 'x-demo': true }, models: [{ id: 'mock-model', name: '测试模型', contextWindow: 128000, maxTokens: 4096, reasoning: true, input: ['text', 'image'], headers: { 'x-model': true } }], modelOverrides: { 'mock-model': { headers: { 'x-override': true }, compat: { supportsDeveloperRole: false } } } } },
  credentials: { mock: { configured: true, type: 'oauth' } },
  credentialSources: { mock: { locations: [{ source: 'storage', type: 'oauth' }, { source: 'catalog', scope: 'provider', field: 'apiKey' }, { source: 'catalog', scope: 'provider', field: 'headers', header: 'x-demo' }], verification: 'unverified' } },
  models: [{ ...selection, name: '测试模型', thinkingLevels: ['off', 'low', 'medium', 'high'] }],
  defaultModel: null, summaryModel: null, runtimeDefault: selection, runtimeOverrides: { model: false, thinking: false }, busyProviders: [],
};
const redact = (value, field) => field === 'apiKey' ? true : field === 'headers' ? Object.fromEntries(Object.keys(value).map(key => [key, true])) : Array.isArray(value) ? value.map(item => redact(item)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, key)])) : value;
window.settingsRequests = [];
const snapshot = { product: 'ruukoto-code', projects: [], sessions: [], tasks: [], confirmations: [], artifacts: [], previews: {}, instanceId: 'synthetic-models', execution: { backend: 'local', note: '合成 bridge，不代表原生验收' }, defaultModel: { provider: 'mock', id: 'mock-model', name: '测试模型', thinkingLevel: 'off' }, mainSessionId: null };
window.ruukoto = {
  subscribe(target, receive) { setTimeout(() => { receive({ type: 'state', state: target === 'code' ? 'online' : 'closed' }); if (target === 'code') receive({ type: 'snapshot', instanceChanged: false, result: { snapshot, replay: [], seq: 0 } }); }, 20); return () => {}; },
  async request(target, op, params) {
    window.settingsRequests.push({ target, op });
    if (op === 'get_model_config') return { ok: true, value: structuredClone(view) };
    if (op === 'save_model_catalog') { view.providers = redact(params.providers); view.models = Object.entries(view.providers).flatMap(([provider, definition]) => (definition.models ?? []).map(model => ({ provider, modelId: model.id, name: model.name || model.id, thinkingLevels: model.reasoning ? ['off', 'low', 'medium', 'high'] : ['off'] }))); }
    else if (op === 'set_model_api_key') { view.credentials[params.provider] = { configured: true, type: 'api_key' }; const sources = view.credentialSources[params.provider] ??= { locations: [], verification: 'unverified' }; sources.locations = [{source:'storage', type:'api_key'}, ...sources.locations.filter(item => item.source !== 'storage')]; }
    else if (op === 'remove_model_api_key') { delete view.credentials.mock; view.credentialSources.mock.locations = view.credentialSources.mock.locations.filter(item => item.source !== 'storage'); }
    else if (op === 'set_default_model') view.defaultModel = { provider: params.provider, modelId: params.model_id, thinkingLevel: params.thinking_level };
    else if (op === 'set_summary_model') view.summaryModel = params.provider === null ? null : { provider: params.provider, modelId: params.model_id };
    else if (op === 'test_model_connection') return { ok: true, value: { ok: true, detail: '合成结果：未请求真实模型' } };
    else if (op === 'list_session_summaries' || op === 'desktop_pending_read') return { ok: true, value: [] };
    else if (op === 'list_models') return { ok: true, value: { models: [], nextOffset: null } };
    else return { ok: false, error: { code: 'fixture_unavailable', outcome: 'not_sent', message: '合成 bridge 未提供此操作。' } };
    view.revision += 'x'; return { ok: true, value: { revision: view.revision } };
  },
  async pickFolder() { return { ok: true, value: null }; }
};
await import('/apps/desktop/src/renderer/main.tsx');
