test("独立审查：a54d5b6 原入口拒绝已发送新工作菜单档案", async t => {
  const f = await fixture(t); const p = await f.open(f.telegram);
  const menu = await f.receive("/工作");
  assert.equal(menu.value.delivery, "sent");
  assert.equal(menu.value.selection?.kind, "work-list");
  await p.close();
  const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; const {directory,config,telegram}=JSON.parse(process.env.RUUKOTO_OLD_VERSION_PROBE); try { const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId,telegram}); await p.close(); throw new Error("旧程序误接纳新菜单档案"); } catch(error) { if(error.code!=="extension_missing") throw error; process.stdout.write(JSON.stringify({code:error.code,message:error.message})+"\\n"); }`;
  const out = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: "/tmp/rk-review-controls-fv8reuo5/old-version", env: { ...process.env, RUUKOTO_OLD_VERSION_PROBE: JSON.stringify({directory:f.directory,config:f.config,telegram:f.telegram}) }, encoding:"utf8" });
  process.stdout.write(out.stdout); process.stderr.write(out.stderr);
  assert.equal(out.status, 0); assert.match(out.stdout, /extension_missing/);
  assert.equal(f.model.calls.length, 0);
});
