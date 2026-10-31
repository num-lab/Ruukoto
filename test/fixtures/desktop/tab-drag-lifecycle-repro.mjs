import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const cells = [];
const effects = [];
let cursor = 0;
const react = {
  useState(initial) {
    const index = cursor++;
    if (!Object.hasOwn(cells, index)) cells[index] = initial;
    return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }];
  },
  useEffect(callback, dependencies) {
    const index = cursor++;
    const prior = cells[index];
    if (!prior || dependencies.some((value, offset) => !Object.is(value, prior[offset]))) {
      cells[index] = dependencies;
      effects.push(callback);
    }
  },
};
const source = readFileSync(resolve(root, 'apps/desktop/src/renderer/tab-order.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
Function('require', 'module', 'exports', output)(name => name === 'react' ? react : require(name), module, module.exports);
const { useTabOrder } = module.exports;
const moves = [];
const order = ['a', 'b', 'c'];
let scope = 'main';
const render = () => {
  cursor = 0;
  const api = useTabOrder(scope, order, (from, to) => moves.push([from, to]), id => id);
  const pending = effects.splice(0);
  for (const effect of pending) effect();
  return api;
};
const rect = { left: 0, right: 308, top: 0, bottom: 40, width: 308, height: 40 };
const list = { querySelector: () => ({ getBoundingClientRect: () => ({ width: 100 }) }), getBoundingClientRect: () => rect, parentElement: { getBoundingClientRect: () => rect } };
globalThis.getComputedStyle = () => ({ columnGap: '4px' });
const transfer = { effectAllowed: '', dropEffect: '', setData() {} };
const event = (x, y = 20) => ({ currentTarget: list, clientX: x, clientY: y, dataTransfer: transfer, preventDefault() {} });
const positions = (api, progress, before) => order.map((id, index) => ({
  id,
  hidden: api.group(id)['data-drag-source'] === 'true',
  x: index * 104 + 104 * (before[index] + (Number(api.group(id).style['--tab-shift']) - before[index]) * progress),
}));

let api = render();
api.trigger('a').onDragStart(event(20));
api = render();
assert.equal(api.trigger('a')['data-dragging'], 'true');
api.list.onDragOver(event(270));
api = render();
assert.equal(api.group('a')['data-drag-source'], 'true');
const before = order.map(id => Number(api.group(id).style['--tab-shift']));
api.list.onDragLeave(event(310));
api = render();
const projected = positions(api, 1 / 3, before);
const a = projected[0];
const c = projected[2];
const overlap = !a.hidden && !c.hidden ? Math.max(0, Math.min(a.x + 100, c.x + 100) - Math.max(a.x, c.x)) : 0;
process.stdout.write(JSON.stringify({ phase: 'leave-after-preview', nativeDragActive: api.trigger('a')['data-dragging'], sourceHidden: api.group('a')['data-drag-source'], before, after: order.map(id => Number(api.group(id).style['--tab-shift'])), projected, overlap, moves }, null, 2) + '\n');
assert.equal(api.trigger('a')['data-dragging'], 'true', '离开 tab 区不应结束原生拖动');
assert.equal(api.group('a')['data-drag-source'], 'true', '源 tab 在首次避让后必须隐藏至 dragend/drop，回程不得与邻居重叠');
assert.equal(overlap, 0, '原生拖动期间，源 tab 回程不得与相邻 tab 重叠');
api.list.onDragOver(event(270));
api = render();
assert.equal(api.group('a')['data-drag-source'], 'true');
api.trigger('a').onDragEnd();
api = render();
assert.equal(api.group('a')['data-drag-source'], undefined);
assert.equal(api.trigger('a')['data-dragging'], undefined);
assert.deepEqual(order.map(id => Number(api.group(id).style['--tab-shift'])), [0, 0, 0]);
assert.deepEqual(moves, []);
api.trigger('a').onDragStart(event(20)); api = render();
api.list.onDragOver(event(270)); api = render();
api.list.onDrop(event(270)); api = render();
assert.deepEqual(moves, [['a', 'c']]);
assert.equal(api.group('a')['data-drag-source'], undefined);
assert.equal(api.trigger('a')['data-dragging'], undefined);
api.trigger('a').onDragStart(event(20)); api = render();
api.list.onDragOver(event(270)); api = render();
scope = 'replacement'; render(); api = render();
assert.equal(api.trigger('a')['data-dragging'], undefined);
process.stdout.write('PASS: source lifecycle, cancel, re-entry, drop, scope reset\n');
