async page => {
  page.setDefaultTimeout(15000);
  await page.locator('.workspace-session').filter({ hasText: 'gui-live-session' }).click();
  const input = page.getByRole('textbox', { name: '输入消息', exact: true });
  await input.fill('gui-live: Verify dynamic Working follow after scroll repair.');
  await input.press('Enter');
  const scroll = page.getByRole('region', { name: '会话消息', exact: true });
  await scroll.getByRole('status').filter({ hasText: /^Working$/ }).waitFor();
  await scroll.hover({ position: { x: 200, y: 200 } });
  await page.mouse.wheel(0, 20000);
  await page.waitForTimeout(350);
  const geometry = () => scroll.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop }));
  const initial = await geometry();
  if (Math.abs(initial.gap) > 2) throw new Error('Working 初始末尾错误：' + JSON.stringify(initial));
  const toggle = async (button, label) => {
    await page.evaluate(() => {
      window.__qaCollapseFrames = [];
      const started = performance.now();
      const tick = () => {
        const el = document.querySelector('.stream-scroll');
        window.__qaCollapseFrames.push({ t: performance.now() - started, top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop });
        if (performance.now() - started < 500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await button.click();
    await page.waitForTimeout(550);
    const result = { label, final: await geometry(), frames: await page.evaluate(() => window.__qaCollapseFrames) };
    if (Math.abs(result.final.gap) > 2) throw new Error(label + ' 后丢失末尾：' + JSON.stringify(result));
    return result;
  };
  const collapse = await toggle(scroll.getByRole('button', { name: 'Working', exact: true }), '收起 Working');
  const expand = await toggle(scroll.getByRole('button', { name: 'Working', exact: true }), '展开 Working');
  const detail = await toggle(scroll.getByRole('button', { name: /^Running printf 'WORKING_FIRST_STARTED/ }), '展开运行工具详情');
  await page.screenshot({ path: '/Users/eitrous/.codex/worktrees/desktop-write-patch/ruukoto/.scratch/desktop-shadcn/evidence/2026-10-16/migration-v3/output/playwright/working-scroll-follow.png' });
  return { initial, collapse, expand, detail, runningGroupAndToolExpansionFollowed: true };
}
