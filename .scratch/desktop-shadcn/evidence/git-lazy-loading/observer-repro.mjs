import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const cells = [], effects = [], observers = [];
let cursor = 0;
const react = {
  useMemo: compute => compute(),
  useRef(initial) {
    const index = cursor++;
    return cells[index] ??= { current: initial };
  },
  useEffect(callback, dependencies) {
    const index = cursor++, prior = cells[index];
    if (!prior || dependencies.some((value, offset) => !Object.is(value, prior.dependencies[offset]))) {
      prior?.cleanup?.();
      cells[index] = { dependencies };
      effects.push(() => { cells[index].cleanup = callback(); });
    }
  },
};
const jsx = (type, props) => ({ type, props });
function load(file) {
  const source = readFileSync(resolve(root, file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  Function('require', 'module', 'exports', output)(name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === './git-graph-data.ts') return load('apps/desktop/src/renderer/git-graph-data.ts');
    return new Proxy({}, { get: (_target, key) => key });
  }, module, module.exports);
  return module.exports;
}
globalThis.IntersectionObserver = class {
  constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
  observe(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
  notify(isIntersecting = true) { this.callback([{ target: this.target, isIntersecting }]); }
};
const { GitGraphPanel } = load('apps/desktop/src/renderer/git-graph.tsx');
const viewport = {}, sentinel = {};
let calls = 0;
let props = { name: 'test', repository: { head: 'head', commits: [{ id: 'head', parents: ['older'], subject: 'head', author: 'a', date: '2026-10-17', refs: [] }], nextCursor: 'page1' }, active: true, loading: false, onRefresh() {}, onLoadMore() { calls++; } };
function render(patch = {}) {
  props = { ...props, ...patch }; cursor = 0;
  const tree = GitGraphPanel(props);
  function mount(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(mount); return; }
    if (node.props?.ref) node.props.ref.current = node.props.className?.includes('git-graph-log') ? viewport : sentinel;
    mount(node.props?.children);
  }
  const list = find(tree, node => node.type === "ol");
  if (list) assert.ok(find(list, node => node.props?.ref && node.props.ref.current !== viewport), "哨兵必须位于自然宽度的列表内，横向滚动不丢失交叉");
  mount(tree);
  for (const effect of effects.splice(0)) effect();
  return tree;
}
render();
assert.equal(observers.length, 1, '有下一页的面板应观察末尾');
const first = observers.at(-1);
assert.equal(first.options.root, viewport);
assert.equal(first.target, sentinel);
assert.equal(first.options.rootMargin, '0px 0px 224px 0px');
first.notify(false); assert.equal(calls, 0, '未接近末尾不读取');
render({ onLoadMore() { calls += 10; } });
assert.equal(observers.length, 1, '同cursor无关更新不重建观察');
first.notify(); first.notify();
assert.equal(calls, 10, '回调使用最新调用方，同次观察只请求一次');
render({ loadingMore: true });
assert.equal(first.disconnected, true);
first.notify(); assert.equal(calls, 10, '清理后的通知失效');
render({ loadingMore: false, repository: { ...props.repository, nextCursor: 'page2' } });
observers.at(-1).notify(); assert.equal(calls, 20, '下一页仍交叉时可继续加载');
render({ moreError: '读取失败' });
const failedCount = observers.length;
render({ onLoadMore() { calls++; } });
assert.equal(observers.length, failedCount, '错误不自动重试');
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  return predicate(node) ? node : find(node.props?.children, predicate);
}
const failureTree = render();
find(failureTree, node => node.props?.children === '重试').props.onClick();
assert.equal(calls, 21, '追加错误允许显式重试');
render({ moreError: undefined, loadingMore: true });
render({ loadingMore: false, repository: { ...props.repository, nextCursor: 'page3' } });
const resumed = observers.at(-1); resumed.notify(); assert.equal(calls, 22);
render({ active: false }); resumed.notify(); assert.equal(calls, 22, '隐藏或离线时旧通知不请求');
const pausedCount = observers.length;
render(); assert.equal(observers.length, pausedCount);
render({ active: true }); observers.at(-1).notify(); assert.equal(calls, 23, '重新打开继续观察');
render({ error: '刷新失败' });
const refreshTree = render();
assert.equal(find(refreshTree, node => node.props?.children === '重试'), undefined, '刷新失败沿用刷新入口');
const errorCount = observers.length;
render(); assert.equal(observers.length, errorCount);
render({ error: undefined, loading: true });
render(); assert.equal(observers.length, errorCount, '刷新中不追加');
render({ loading: false, repository: { ...props.repository, nextCursor: null } });
assert.equal(observers.length, errorCount, '最终页不再观察');
render({ repository: { ...props.repository, nextCursor: 'page4' } });
const closing = observers.at(-1);
for (const cell of cells) cell?.cleanup?.();
closing.notify(); assert.equal(calls, 23, '卸载后通知无效');
process.stdout.write('PASS: near-end paging, deduplication, continuation, pause, retry, refresh and unmount\n');
