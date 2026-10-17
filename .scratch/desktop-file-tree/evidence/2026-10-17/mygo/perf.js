(() => {
  const bridge = window.ruukoto;
  if (!bridge) throw new Error('QA: ruukoto preload missing');
  const result = { environment: 'QA-only passive observer / real MyGo bridge', requests: [], actions: [], invalidations: [] };
  const cachedPaths = new Set();
  let active = null, scheduled = false;
  const clock = () => Math.round(performance.now() * 1000) / 1000;
  const show = () => {
    let output = document.getElementById('qa-file-tree-performance');
    if (!output) {
      output = document.createElement('pre');
      output.id = 'qa-file-tree-performance';
      output.setAttribute('aria-label', '文件树性能验收');
      output.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:2147483647;max-width:520px;max-height:48px;overflow:hidden;pointer-events:none;font:8px/1.2 monospace;color:#bbb;background:#171717;padding:2px;margin:0';
      document.body.append(output);
    }
    output.textContent = JSON.stringify(result);
    void window.mygo.call('Desktop.ReportFileTreePerf', result).catch(error => { result.reportError = String(error); });
  };
  const pathKey = (workspace, path) => `${workspace}:${path}`;
  const originalRequest = bridge.request.bind(bridge);
  bridge.request = async (target, op, params) => {
    if (target !== 'code' || op !== 'list_workspace_files') return originalRequest(target, op, params);
    const record = { id: result.requests.length + 1, path: params.path ?? '', workspaceId: params.workspace_id, startedMs: clock() };
    result.requests.push(record);
    try {
      const response = await originalRequest(target, op, params);
      Object.assign(record, { settledMs: clock(), ok: response.ok, entries: response.ok ? response.value.entries.length : null });
      record.elapsedMs = Math.round((record.settledMs - record.startedMs) * 1000) / 1000;
      if (response.ok) cachedPaths.add(pathKey(params.workspace_id, params.path ?? ''));
      else record.error = response.error.code;
      return response;
    } catch (error) {
      Object.assign(record, { settledMs: clock(), ok: false, error: String(error) });
      throw error;
    } finally { checkLater(); }
  };
  const originalSubscribe = bridge.subscribe.bind(bridge);
  bridge.subscribe = (target, listener) => originalSubscribe(target, update => {
    if (target === 'code' && (update.type === 'snapshot' || (update.type === 'state' && update.state !== 'online'))) {
      cachedPaths.clear();
      result.invalidations.push({ atMs: clock(), type: update.type, state: update.state ?? null, instanceChanged: update.instanceChanged ?? null });
    }
    listener(update);
  });
  const visible = node => {
    if (!node || !node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') return false;
    const rect = node.getBoundingClientRect();
    const viewport = node.closest('.file-tree')?.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, viewport?.top ?? 0) && rect.top < Math.min(innerHeight, viewport?.bottom ?? innerHeight) && rect.right > 0 && rect.left < innerWidth;
  };
  function inspect(action) {
    const container = action.kind === 'folder-expand' ? action.button.closest('li')?.querySelector(':scope > ul') : document.querySelector('.workspace-files .file-tree > ul');
    if (!visible(container)) return null;
    if (action.kind === 'folder-expand' && action.button.getAttribute('aria-expanded') !== 'true') return null;
    const text = container.textContent ?? '';
    if (text.includes('正在读取')) return null;
    const error = container.querySelector('[role="alert"]');
    if (error) return { error: error.textContent, rowCount: 0 };
    const rows = [...container.querySelectorAll(':scope > li > .file-tree-row')].filter(visible);
    if (!rows.length && !text.includes('暂无文件')) return null;
    return { rowCount: rows.length, empty: !rows.length };
  }
  function finish(action, rows) {
    if (active !== action) return;
    const newRequests = result.requests.slice(action.requestStart).filter(item => item.path === action.path);
    Object.assign(action, { visibleMs: clock(), rowsMs: Math.round((clock() - action.startedMs) * 1000) / 1000, requestIds: newRequests.map(item => item.id), cacheHit: newRequests.length === 0, rowCount: rows.rowCount, empty: rows.empty ?? false, passed: !rows.error && (!action.expectedCache || newRequests.length === 0) });
    if (rows.error) action.error = rows.error;
    if (action.expectedCache && newRequests.length) action.error = 'cached re-expansion sent a request';
    delete action.button;
    delete action.requestStart;
    active = null;
    setTimeout(show, 0);
  }
  function check() {
    scheduled = false;
    const action = active;
    if (!action) return;
    if (clock() - action.startedMs > 10000) { finish(action, { rowCount: 0, error: 'visible rows timeout' }); return; }
    const rows = inspect(action);
    if (!rows) { checkLater(); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (active !== action) return;
      const current = inspect(action);
      if (current) finish(action, current); else checkLater();
    }));
  }
  function checkLater() { if (active && !scheduled) { scheduled = true; requestAnimationFrame(check); } }
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button) return;
    const folder = button.matches('.file-tree-row:not(.file-tree-file)');
    const root = !folder && button.textContent.trim() === '文件树' && (button.closest('.new-tab-page') || button.getAttribute('role') === 'tab');
    if (!folder && !root) return;
    if (folder && button.getAttribute('aria-expanded') === 'true') return;
    if (active) finish(active, { rowCount: 0, error: 'superseded by another action' });
    const path = folder ? button.getAttribute('aria-label') : '';
    const wasCached = [...cachedPaths].some(item => item.endsWith(`:${path}`));
    active = { id: result.actions.length + 1, kind: folder ? 'folder-expand' : 'root-open', path, startedMs: clock(), requestStart: result.requests.length, expectedCache: wasCached };
    Object.defineProperty(active, 'button', { value: button, configurable: true });
    result.actions.push(active);
    checkLater();
  }, true);
  new MutationObserver(checkLater).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'hidden', 'data-state'] });
  document.addEventListener('DOMContentLoaded', show, { once: true });
  window.__qaFileTreePerformance = result;
})();
