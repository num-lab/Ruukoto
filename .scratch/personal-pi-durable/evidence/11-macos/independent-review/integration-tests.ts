test("独立审查：取消提交在 watch 附着之前也能观察", { timeout: 5000 }, async t => {
  let ready: () => Promise<void>;
  const original = PersonalWorkTask.definition.phases.run;
  t.mock.method(PersonalWorkTask.definition.phases, "run", async (...[task, runtime, context]: Parameters<typeof original>) => original(task, { ...runtime, watchDoc: new Proxy(runtime.watchDoc, { async apply(target, receiver, args) {
    await ready();
    await runtime.commit(async tx => { (await tx.doc(PersonalWorkDoc, task.input.requestId, null)).cancelRequested = true; return undefined; }, context);
    return Reflect.apply(target, receiver, args);
  } }) }, context));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => { if (child(request)) await gate; return { kind: "text", text: "完成" }; });
  const p = await f.open(); await source(p);
  ready = () => until(() => f.model.calls.some(child));
  const ref = await p.work.delegate({ requestId: "pre-watch", sourceRequestId: "owner", content: "阻塞" });
  assert.equal((await Promise.race([p.harness.waitForTask(ref.taskId, context), delay(1000).then(() => { throw new Error("初值取消信号未被观察"); })])).state.outcome.status, "aborted");
  assert.ok((await p.work.status(ref)).stopVerified);
});

test("独立审查：正常回答停止后且最终事务前提交取消，以取消事实收尾", { timeout: 5000 }, async t => {
  const original = PersonalWorkTask.definition.phases.run;
  t.mock.method(PersonalWorkTask.definition.phases, "run", async (...[task, runtime, context]: Parameters<typeof original>) => original(task, { ...runtime, conversation: async (id, context) => {
    const value = await runtime.conversation(id, context);
    return value && { ...value, abort: async (context, options) => {
      await value.abort(context, options);
      await runtime.commit(async tx => { (await tx.doc(PersonalWorkDoc, task.input.requestId, null)).cancelRequested = true; return undefined; }, context);
    } };
  } }, context));
  const f = await fixture(t); const p = await f.open(); await source(p);
  const ref = await p.work.delegate({ requestId: "complete-race", sourceRequestId: "owner", content: "正常回答" });
  assert.equal((await p.harness.waitForTask(ref.taskId, context)).state.outcome.status, "aborted");
  assert.ok((await p.work.status(ref)).stopVerified);
});
