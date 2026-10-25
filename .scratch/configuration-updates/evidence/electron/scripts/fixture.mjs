import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { WebSocketServer } from '/Users/eitrous/Developer/ruukoto/node_modules/ws/wrapper.mjs';
import { personalTestKey, personalTestCertificate } from '/Users/eitrous/Developer/ruukoto/test/helpers/personal-https.ts';

export async function startFixture(root) {
  const profile = { directory: path.join(root, 'backend-profile'), id: 'sha256:' + 'a'.repeat(64) };
  const remoteId = randomUUID(), runId = randomUUID(), requests = [], receipts = new Map(), tokens = new Set();
  const digest = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const state = { online: true, next: 'active', drop: false, fileIssue: false, writes: 0,
    model: { api: 'openai-completions', baseUrl: 'https://model.example.test', modelId: 'gui-initial', apiKeyEnv: 'GUI_TEST_API_KEY', contextWindow: 4096, maxTokens: 64, imageInput: false }, skills: null, mcp: { version: 2, generation: randomUUID(), services: [{ id: 'broken-service', label: '坏凭据服务', enabled: true, endpoint: 'https://mcp.example.test', credential: { path: path.join(root, 'absent-mcp-key') }, tools: [{ name: 'read', description: '只读测试工具', inputSchema: { type: 'object' } }] }] } };
  const revisions = { model: digest(state.model), skills: 'missing', mcp: digest(state.mcp) };
  const respond = (res, result, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 1, product: 'ruukoto', ok: true, result }));
  const reject = (res, code, status = 409) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 1, product: 'ruukoto', ok: false, code, message: '受控 GUI 夹具拒绝请求' }));
  const settings = () => ({ product: 'ruukoto', profile, online: state.online, settingsProtocol: 2, revisions, revisionsUnknown: [], effective: [], operations: [...receipts.values()], blockers: [],
    fileIssues: state.fileIssue ? [{ target: 'model', code: 'settings_file_unverified', expectedRevision: revisions.model, actualRevision: 'missing' }] : [],
    model: state.fileIssue ? null : { config: state.model, credential: { state: state.online ? 'missing' : 'unverified', reference: 'GUI_TEST_API_KEY' } },
    skills: { config: state.skills, revision: state.skills ? digest(state.skills) : 'sha256:' + 'b'.repeat(64), skills: [], diagnostics: [], hasMore: false, offset: 0 }, mcp: { ...state.mcp, services: state.mcp.services.map(item => ({ ...item, credentialStatus: 'missing' })), offset: 0, hasMore: false }, lifecycle: { managedDevelopment: true } });
  const view = () => ({ settings: settings(), maintenance: { profile, online: state.online, writable: true, code: 'settings_ready', reason: '配置可独立保存；后台环境缺少测试模型凭据。', lifecycle: { kind: 'development', state: state.online ? 'running' : 'stopped', managedDevelopment: true, originalEnvironment: 'unverified' } }, pending: null, saved: false });
  let origin;
  const server = https.createServer({ key: personalTestKey, cert: personalTestCertificate }, (req, res) => { void handle(req, res).catch(error => { fs.appendFileSync(path.join(root, 'fixture-errors.log'), String(error) + '\n'); if (!res.destroyed) reject(res, 'fixture_internal', 500); }); });
  async function handle(req, res) {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, route = new URL(req.url, origin);
    requests.push({ method: req.method, path: route.pathname });
    const token = req.headers.authorization || '';
    if (route.pathname === '/pair') { if (value?.code !== 'ABCDEFGHIJKL' || !/^Bearer [0-9a-f-]+\./.test(token)) return reject(res, 'remote_pairing_rejected'); tokens.add(token); return respond(res, { id: token.slice(7).split('.')[0], status: 'active' }); }
    if (!tokens.has(token)) return reject(res, 'remote_credential_invalid', 401);
    if (route.pathname === '/handshake') return respond(res, { v: 1, product: 'ruukoto', origin, remoteId, profile, online: state.online, ...(state.online ? { runId } : {}) });
    if (req.headers['x-ruukoto-remote-id'] !== remoteId || req.headers['x-ruukoto-profile-id'] !== profile.id) return reject(res, 'remote_profile_changed');
    if (route.pathname === '/management') return respond(res, view());
    if (route.pathname === '/settings') {
      if (value.op === 'settings.read') return respond(res, settings());
      if (value.op === 'skills.select-directory') return respond(res, { profile, purpose: value.purpose, directory: path.join(root, 'skills-library'), selectable: true, directories: [], offset: 0, hasMore: false, truncated: false });
      if (value.op === 'mcp.get') return respond(res, { profile, service: { ...state.mcp.services.find(item => item.id === value.id), credentialStatus: 'missing' }, toolsOffset: 0, toolsHasMore: false });
      if (value.op === 'mcp.cua-status') return respond(res, { profile, available: false, paused: true, busy: false, operations: [] });
      return reject(res, 'fixture_setting_unhandled');
    }
    if (route.pathname === '/maintenance') {
      if (req.method === 'GET') return respond(res, receipts.get(route.searchParams.get('id')) || null);
      const request = value.request, target = request.op.target || (request.op.kind.startsWith('skills.') ? 'skills' : 'mcp');
      if (request.expectedRevision !== revisions[target]) return reject(res, 'settings_revision_changed');
      const previous = revisions[target]; state.writes++;
      if (request.op.kind === 'config.save') state[target] = request.op.value;
      else if (request.op.kind === 'mcp.set-enabled') state.mcp = { ...state.mcp, generation: randomUUID(), services: state.mcp.services.map(item => item.id === request.op.id ? { ...item, enabled: request.op.enabled } : item) };
      revisions[target] = digest(state[target]);
      const status = !state.online ? 'saved' : state.next;
      const receipt = { v: 2, id: request.id, profile, target, scope: target === 'mcp' && request.op.id ? request.op.id : '*', requestDigest: createHash('sha256').update(JSON.stringify(request)).digest('hex'), status, savedRevision: revisions[target], effectiveRevision: status === 'active' ? revisions[target] : previous, code: status === 'active' ? 'settings_active' : status === 'waiting' ? 'related_operation_pending' : status === 'failed' ? 'settings_apply_failed' : 'settings_saved_offline', relatedOperations: status === 'waiting' ? [{ kind: 'test', id: 'controlled-blocker' }] : [] };
      receipts.set(request.id, receipt); state.next = 'active';
      if (state.drop) { state.drop = false; req.socket.destroy(); return; }
      return respond(res, receipt, 202);
    }
    if (route.pathname === '/permissions') return respond(res, { default: { mode: 'confirm' }, qq: { mode: 'auto-review' } });
    if (['/questions', '/works', '/tools/operations', '/mcp/operations', '/services', '/app-data/operations'].includes(route.pathname)) return respond(res, { items: [] });
    return reject(res, 'fixture_route_missing', 404);
  }
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    requests.push({ method: 'UPGRADE', path: '/events' });
    if (!tokens.has(req.headers.authorization || '')) return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    wss.handleUpgrade(req, socket, head, ws => ws.send(JSON.stringify({ v: 1, type: 'snapshot', runId, subscription: randomUUID(), seq: 0, timeline: { through: 0, items: [] }, live: { tools: [], toolCount: 0, inbox: [], inboxCount: 0 } })));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `https://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(root, 'test-ca.pem'), personalTestCertificate, { mode: 0o600 });
  return { state, profile, origin, requests, receipts, view, close: async () => { fs.writeFileSync(path.join(root, 'wire-summary.json'), JSON.stringify({ requests, writes: state.writes, receipts: [...receipts.values()] }, null, 2)); for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
