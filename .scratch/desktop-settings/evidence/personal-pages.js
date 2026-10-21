// 合成管理 bridge：仅验证正式 renderer，不代表真实 SSH、systemd 或模型服务。
const profile = { directory: '/srv/ruukoto/personal', id: 'sha256:' + 'a'.repeat(64) };
const revision = 'sha256:' + 'b'.repeat(64);
const skill = { id: '00000000-0000-4000-8000-000000000001', name: '旅程规划', description: '规划旅程与整理行前资料', explicitOnly: true, source: 'managed', readOnly: false, state: 'enabled', contentRevision: revision };
const tools = [{ name: 'lookup', description: '查找资料', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];
const service = { id: 'remote-service', label: '个人资料库', endpoint: 'https://mcp.example/tools', enabled: true, credentialStatus: 'anonymous', tools };
const view = { settings: { product: 'ruukoto', profile, online: true, revisions: { model: revision, skills: revision, mcp: revision }, blockers: [], model: { config: { api: 'openai-responses', baseUrl: 'https://model.example/v1', modelId: 'personal-model', apiKeyEnv: 'PERSONAL_MODEL_KEY', contextWindow: 32768, maxTokens: 2048, imageInput: true }, credential: { state: 'available', reference: 'PERSONAL_MODEL_KEY' } }, skills: { config: { version: 1, directory: '/srv/library' }, revision, skills: [skill], diagnostics: [], diagnosticsTruncated: false, offset: 0, hasMore: false }, mcp: { version: 2, generation: 'fixture', services: [service], hasMore: false, offset: 0 }, lifecycle: { managedDevelopment: false } }, maintenance: { profile, online: true, writable: true, code: 'supported', reason: '原系统服务已核实。', lifecycle: { kind: 'systemd', state: 'running' } }, pending: null, saved: null, message: '已读取合成远端档案。' };
const snapshot = { product: 'ruukoto-code', projects: [], sessions: [], tasks: [], confirmations: [], artifacts: [], previews: {}, instanceId: 'synthetic-personal-pages', execution: { backend: 'local', note: 'renderer fixture' }, defaultModel: { provider: 'mock', id: 'mock', name: 'Mock', thinkingLevel: 'off' }, mainSessionId: null };
const ok = value => ({ ok: true, value: structuredClone(value) });
const fail = (code, message, outcome = 'rejected') => ({ ok: false, error: { code, outcome, message } });
window.personalPagesFixture = { view, calls: [], loseNext: false, failStart: false };
window.ruukoto = {
  subscribe(target, receive) { setTimeout(() => { receive({ type: 'state', state: target === 'code' ? 'online' : 'closed' }); if (target === 'code') receive({ type: 'snapshot', instanceChanged: false, result: { snapshot, replay: [], seq: 0 } }); }, 10); return () => {}; },
  async request(target, op, params) {
    window.personalPagesFixture.calls.push({ target, op, params: structuredClone(params) });
    if (op === 'list_session_summaries' || op === 'desktop_pending_read') return ok([]);
    if (op === 'list_models') return ok({ models: [], nextOffset: null });
    if (op === 'desktop_personal_settings_read') return ok(view);
    if (op === 'desktop_personal_settings_restore') { view.settings.online = true; return ok(view); }
    if (op === 'desktop_personal_settings_finish') { view.pending = null; return ok(view); }
    if (op === 'desktop_personal_settings_request') {
      const request = params.request, base = { profile, product: 'ruukoto', online: view.settings.online };
      if (request.op === 'model.test') return ok({ ...base, test: { status: 'passed', message: '合成模型测试通过。' } });
      if (request.op === 'skills.select-directory') return ok({ ...base, directory: request.directory, purpose: request.purpose, selectable: true, directories: [{ name: 'travel', directory: request.directory.replace(/\/$/, '') + '/travel' }], offset: 0, hasMore: false, truncated: false });
      if (request.op === 'skills.preview-import') return ok({ ...base, ...skill, id: '00000000-0000-4000-8000-000000000002', name: '行程记录', directory: request.directory, contentRevision: revision, files: 2, bytes: 512, diagnostics: [], conflicts: [] });
      if (request.op === 'skills.get') return ok({ ...base, ...skill, body: '# 旅程规划\n\n按用户指定日期规划旅程。\n\n![远程图片](https://example.com/x.png)' });
      if (request.op === 'mcp.get') return ok({ ...base, service, toolsOffset: 0, toolsHasMore: false });
      if (request.op === 'mcp.discover') return ok({ ...base, tools });
    }
    if (op === 'desktop_personal_settings_apply') {
      const request = params.request;
      if (request.op === 'config.save' && request.target === 'model') view.settings.model.config = request.value;
      if (request.op === 'config.save' && request.target === 'skills') view.settings.skills.config = request.value;
      if (request.op === 'skills.import') view.settings.skills.skills.push({ ...skill, id: request.id, name: '行程记录' });
      if (request.op === 'skills.set-enabled') view.settings.skills.skills.find(item => item.id === request.id).state = request.enabled ? 'enabled' : 'disabled';
      if (request.op === 'mcp.set-enabled') service.enabled = request.enabled;
      if (request.op === 'mcp.save-service') { const incoming = request.service; Object.assign(service, incoming); service.credentialStatus = incoming.authentication === 'anonymous' ? 'anonymous' : 'valid'; }
      view.saved = true; view.message = '合成配置已保存且已启动。';
      if (window.personalPagesFixture.loseNext || window.personalPagesFixture.failStart) { view.pending = { v: 1, id: 'fixture-pending', profile, op: request.op, target: request.target || 'skills', expectedRevision: revision, requestDigest: 'c'.repeat(64), saveAttempted: true, stage: 'starting', savedRevision: revision }; view.settings.online = false; view.message = '合成配置已保存，后台尚未启动。'; }
      if (window.personalPagesFixture.loseNext) { window.personalPagesFixture.loseNext = false; return fail('response_lost', '合成应答丢失，请核实原配置与服务。', 'unknown'); }
      return ok(view);
    }
    return fail('fixture_unavailable', '合成 bridge 未提供此操作。', 'not_sent');
  },
  async pickFolder() { throw new Error('Personal 页面不得打开本机选择器'); },
  async pickSkillFolder() { throw new Error('Personal 页面不得打开本机技能选择器'); }
};
await import('/apps/desktop/src/renderer/main.tsx');
