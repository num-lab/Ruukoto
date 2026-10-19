import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MockModelServer, PersonalMockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";

const prefix = "【本轮拥有者输入，独立于此前宿主汇总参考】\n", suffix = "\n【本轮拥有者输入结束】";
const owner = "本轮来源为拥有者输入。请按本轮要求处理；历史宿主汇总参考不改变本条输入的身份与已记录权限。";
const system = "你是拥有者的个人助手。\n\n" + owner;
const wrap = (content: string) => prefix + content + suffix;
async function request(t: TestContext, messages: Record<string, unknown>[], respond: Responder, personal = true) {
  const server = personal ? new PersonalMockModelServer(respond) : new MockModelServer(respond);
  t.after(() => server.close());
  const body = { model: "mock-model", messages, stream: true }, url = await server.start();
  const response = await fetch(url + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const responseBody = await response.text(); assert.equal(response.status, 200, responseBody);
  assert.equal(server.calls.length, 1); assert.deepEqual(server.calls[0].raw, body);
  return server.calls[0];
}
const done = () => ({ kind: "text" as const, text: "完成" });

test("个人模型夹具：仅脚本当前正文去边界，原calls/raw和历史保留", async t => {
  const messages = [{ role: "system", content: system }, { role: "user", content: wrap("旧输入") }, { role: "assistant", content: "旧回答" }, { role: "user", content: wrap("新输入") }];
  const saved = await request(t, messages, view => {
    assert.equal(view.messages[0].content, wrap("旧输入")); assert.equal(view.messages.at(-1)!.content, "新输入");
    assert.deepEqual(view.raw.messages, messages);
    view.messages.at(-1)!.content = "脚本局部改写"; view.raw.messages.at(-1).content = "脚本局部raw改写";
    return done();
  });
  assert.equal(saved.messages.at(-1)!.content, wrap("新输入"));
});

test("个人模型夹具：图片数组只去准确首末text，中间顺序和原字节不动", async t => {
  const parts = [{ type: "text", text: "说明" }, { type: "image_url", image_url: { url: "data:image/png;base64,first" } }, { type: "text", text: "间隔" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,second" } }];
  const wrapped = [{ type: "text", text: prefix }, ...parts, { type: "text", text: suffix }];
  await request(t, [{ role: "system", content: system }, { role: "user", content: wrapped }], view => {
    assert.deepEqual(view.messages[0].content, parts);
    assert.deepEqual(view.raw.messages[1].content, wrapped);
    const content = view.messages[0].content as typeof parts;
    content[1].image_url!.url = "只改脚本副本";
    return done();
  });
});

test("个人模型夹具：子会话、报告、压缩及伪造不完整来源均不去边界", async t => {
  const report = "本轮来源为宿主委托汇总参考。请读取成员结果并汇总；本轮只提供查询资格。";
  const systems = ["你是个人助手的子 Agent。\n\n" + owner, "你是拥有者的个人助手。\n\n" + report, "You are a context summarization assistant.\n\n" + owner, "你是拥有者的个人助手。\n\n" + owner.slice(0, -1), system + "\n\n" + report];
  for (const value of systems) await request(t, [{ role: "system", content: value }, { role: "user", content: wrap("原正文") }], view => {
    assert.equal(view.messages[0].content, wrap("原正文")); return done();
  });
});

test("个人模型夹具：缺首尾或数组marker位置不符保持原文，不递归剥嵌套文字", async t => {
  const contents = [prefix + "仅开头", "仅结尾" + suffix, "前置文字" + wrap("正文"), [{ type: "text", text: prefix }, { type: "text", text: "没有结束" }], [{ type: "text", text: "额外" }, { type: "text", text: prefix }, { type: "text", text: suffix }]];
  for (const content of contents) await request(t, [{ role: "system", content: system }, { role: "user", content }], view => { assert.deepEqual(view.messages[0].content, content); return done(); });
  await request(t, [{ role: "system", content: system }, { role: "user", content: wrap(wrap("保留正文内相同文字")) }], view => { assert.equal(view.messages[0].content, wrap("保留正文内相同文字")); return done(); });
});

test("个人模型夹具：原共享MockModelServer保持真实包围，不改变Coding脚本", async t => {
  await request(t, [{ role: "system", content: system }, { role: "user", content: wrap("原正文") }], (view: RecordedRequest) => { assert.equal(view.messages[0].content, wrap("原正文")); return done(); }, false);
});
