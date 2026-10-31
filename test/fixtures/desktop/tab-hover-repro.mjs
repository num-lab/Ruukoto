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

let api = render(); api = render();
api.list.onPointerMove?.({}); api = render();
assert.notEqual(api.list['data-hover-paused'], 'true');
api.trigger('a').onDragStart(event(20)); api = render();
assert.equal(api.list['data-hover-paused'], 'true', '拖动开始即撤销旧hover资格');
api.list.onPointerMove?.({}); api = render();
assert.equal(api.list['data-hover-paused'], 'true', '拖动期间指针事件不能恢复hover');
api.list.onDragOver(event(270)); api = render();
api.list.onDrop(event(270)); api = render();
api.trigger('a').onDragEnd(); api = render();
assert.equal(api.list['data-hover-paused'], 'true', 'drop及dragend之后旧位置hover仍应暂停');
api.list.onPointerMove?.({}); api = render();
assert.notEqual(api.list['data-hover-paused'], 'true', '后续指针移动恢复正常hover');
api.trigger('a').onDragStart(event(20)); api = render();
api.trigger('a').onDragEnd(); api = render();
assert.equal(api.list['data-hover-paused'], 'true', '取消拖动也应清理原位置hover');
api.list.onPointerMove?.({}); api = render();
let focused = false;
globalThis.window = { requestAnimationFrame: callback => callback() };
api.trigger('a').onKeyDown({altKey:true,shiftKey:true,key:'ArrowRight',preventDefault(){},currentTarget:{focus(){focused=true;}}}); api = render();
assert.equal(focused,true,'键盘排序保留焦点');
assert.equal(api.list['data-hover-paused'],'true','键盘排序也清除旧位置hover');
api.list.onPointerMove?.({}); api = render();
scope = 'next'; render(); api = render();
assert.equal(api.list['data-hover-paused'],'true','换组需重新取得指针位置');
process.stdout.write('PASS: drag/drop/cancel suppress stale hover, pointer restores it, keyboard focus retained\n');
