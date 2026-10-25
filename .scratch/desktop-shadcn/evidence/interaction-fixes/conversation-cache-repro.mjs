import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] ?? process.cwd());
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const React = require('react');
let cells = [], cursor = 0;
const hook = {
  ...React,
  useRef(value) { const index = cursor++; return cells[index] ??= { current: value }; },
  useState(initial) { const index = cursor++; if (!Object.hasOwn(cells, index)) cells[index] = initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }]; },
  useMemo(callback, dependencies) { const index = cursor++; const prior = cells[index]; if (!prior || dependencies.some((value, offset) => !Object.is(value, prior.dependencies[offset]))) cells[index] = { value: callback(), dependencies }; return cells[index].value; },
};
const load = (path, extra = '', overrides = {}) => {
  const source = readFileSync(resolve(root, path), 'utf8') + extra;
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  Function('require', 'module', 'exports', output)(name => name === 'react' ? hook : Object.hasOwn(overrides, name) ? overrides[name] : require(name), module, module.exports);
  return module.exports;
};
const activity = load('apps/desktop/src/renderer/activity.ts');
const diff = load('apps/desktop/src/renderer/diff.ts');
const dummy = names => Object.fromEntries(names.map(name => [name, function Placeholder() {}]));
const MarkdownText = function MarkdownText() {};
const { Conversation, MessageEntry } = load('apps/desktop/src/renderer/conversation.tsx', '\nexport { MessageEntry };\n', {
  './diff.ts': diff, './activity.ts': activity,
  './markdown.tsx': { MarkdownText },
  './tool-activity.tsx': dummy(['AgentActivity', 'ExecutionTrace', 'ToolActivity']),
  './approval-cards.tsx': dummy(['ApprovalCards']),
  './owner-question-cards.tsx': dummy(['OwnerQuestionCard', 'OwnerQuestionCards']),
  './components/ui/bubble.tsx': dummy(['Bubble', 'BubbleContent']),
  './components/ui/message.tsx': dummy(['Message', 'MessageContent']),
  './components/ui/message-scroller.tsx': dummy(['MessageScroller', 'MessageScrollerContent', 'MessageScrollerItem', 'MessageScrollerProvider', 'MessageScrollerViewport']),
});
const stores = new Map();
function render(key, component, props) { cells = stores.get(key) ?? []; stores.set(key, cells); cursor = 0; return component(props); }
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props?.children)];
let items = [];
const tasks = new Map();
const opened = [];
const session = { flow: { get items() { return items; } }, historyCursor: null };
const model = { historyReady: () => true, target: 'code', status: { state: 'offline' }, view: { openSession: () => session, activeTaskFor: () => null, pendingApprovals: () => [], tasks, ownerQuestions: [] }, inspector: { toolResult() {}, openDiff: (sessionId, tool) => opened.push({ sessionId, tool }) } };
const message = (key, text, extras = {}) => ({ kind: 'message', key, text, role: 'assistant', ...extras });
const edit = (key, target) => ({ kind: 'tool', key, name: 'edit', target, entryId: null, status: 'done' });
const before = message('before', '`p.ts`');
const first = edit('tool:first', 'p.ts');
const m1 = message('m1', '`p.ts`');
const second = edit('tool:second', 'p.ts');
const m2 = message('m2', '`p.ts`');
items = [before, first, m1, second, m2];
function messageTrees(child = false) {
  const tree = render('conversation', Conversation, { model, sessionId: 's', child });
  return new Map(nodes(tree).filter(node => node.type === MessageEntry).map(node => [node.props.entry.key, render(`message:${node.props.entry.key}`, MessageEntry, node.props)]));
}
const markdown = tree => nodes(tree).find(node => node.type === 'div' && node.props.className === 'markdown');
const code = (tree, path) => markdown(tree).props.children.props.components.inlineCode({ children: path });
const click = link => link.props.onClick({ preventDefault() {} });
let trees = messageTrees();
assert.equal(code(trees.get('before'), 'p.ts').type, 'code', '未来 edit 不应把之前正文变成链接');
click(code(trees.get('m1'), 'p.ts')); assert.equal(opened.at(-1).tool, first);
click(code(trees.get('m2'), 'p.ts')); assert.equal(opened.at(-1).tool, second, '同路径引用绑定最近的前置编辑');
const initialMarkdown = markdown(trees.get('m1'));
trees = messageTrees();
assert.equal(markdown(trees.get('m1')), initialMarkdown, '无关刷新应复用 Markdown 子树');
const replacement = { ...first, entryId: 'authoritative' };
items[1] = replacement;
trees = messageTrees();
assert.notEqual(markdown(trees.get('m1')), initialMarkdown, 'entryId 权威补读必须失效缓存');
const replacedMarkdown = markdown(trees.get('m1'));
const sameSignatureReplacement = { ...replacement };
items[1] = sameSignatureReplacement;
trees = messageTrees();
assert.equal(markdown(trees.get('m1')), replacedMarkdown, '同语义对象替换无需重解析 Markdown');
click(code(trees.get('m1'), 'p.ts'));
assert.equal(opened.at(-1).tool, sameSignatureReplacement, '缓存链接点击时必须读取当前对象');
sameSignatureReplacement.target = 'q.ts';
trees = messageTrees();
assert.equal(code(trees.get('m1'), 'p.ts').type, 'code', '原地 target 更新必须删除旧链接');
m1.text = '`q.ts`';
trees = messageTrees();
click(code(trees.get('m1'), 'q.ts')); assert.equal(opened.at(-1).tool, sameSignatureReplacement, '流式/权威正文变化应重新解析');
const attachmentMarkdown = markdown(trees.get('m1'));
m1.attachments = [{ id: 'fresh', name: 'fresh.txt' }];
trees = messageTrees();
assert.equal(markdown(trees.get('m1')), attachmentMarkdown);
assert.ok(nodes(trees.get('m1')).some(node => Array.isArray(node.props?.children) && node.props.children.join('') === '［附件：fresh.txt］'), '附件在缓存外必须即时刷新');
const childMessage = message('child-user', 'raw', { role: 'user', taskId: 'child-task' });
items = [childMessage]; tasks.set('child-task', { displayInput: 'display-one' });
trees = messageTrees(true);
assert.equal(markdown(trees.get('child-user')).props.children.props.children, 'display-one');
tasks.set('child-task', { displayInput: 'display-two' });
trees = messageTrees(true);
assert.equal(markdown(trees.get('child-user')).props.children.props.children, 'display-two', '子会话 displayInput 更新应即时显示');
items = []; session.historyLoaded = true;
assert.ok(!JSON.stringify(render('conversation', Conversation, { model, sessionId: 's' })).includes('开始一个新的会话'), '空会话成功加载后留白');
session.historyLoaded = false;
assert.ok(JSON.stringify(render('conversation', Conversation, { model, sessionId: 's' })).includes('正在加载会话'), '真正历史加载仍反馈');
model.target = 'personal'; items = [first, m1];
trees = messageTrees();
assert.equal(code(trees.get('m1'), 'q.ts').type, 'code', 'PA 不生成 diff 侧栏链接');
process.stdout.write('PASS: preceding-only/latest paths, stable memo, entryId and target mutation, live replacement, text, attachments, child displayInput, PA guard\n');
