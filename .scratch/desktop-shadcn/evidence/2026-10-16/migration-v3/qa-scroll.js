async page => {
  page.setDefaultTimeout(10000);
  await page.locator('.workspace-session').filter({ hasText: 'gui-scroll 00' }).click();
  const scroll = page.getByRole('region', { name: '会话消息', exact: true });
  await scroll.getByText('gui-scroll 27', { exact: true }).first().waitFor({ state: 'attached' });
  await page.waitForTimeout(500);
  const before = await scroll.evaluate(el => {
    el.scrollTop = 20;
    const item = [...el.querySelectorAll('[data-message-id]')].find(item => item.getBoundingClientRect().top >= el.getBoundingClientRect().top);
    const value = { id: item.getAttribute('data-message-id'), top: item.getBoundingClientRect().top, count: el.querySelectorAll('[data-message-id]').length };
    el.dispatchEvent(new Event('scroll'));
    return value;
  });
  await page.waitForFunction(count => document.querySelector('.stream-scroll').querySelectorAll('[data-message-id]').length > count, before.count);
  await page.waitForTimeout(230);
  const after = await scroll.evaluate((el, before) => {
    const item = [...el.querySelectorAll('[data-message-id]')].find(item => item.getAttribute('data-message-id') === before.id);
    return { id: before.id, top: item.getBoundingClientRect().top, count: el.querySelectorAll('[data-message-id]').length, scrollTop: el.scrollTop };
  }, before);
  if (Math.abs(after.top - before.top) > 1) throw new Error('补页改变了阅读锚点：' + JSON.stringify({ before, after }));
  await page.screenshot({ path: '/Users/eitrous/.codex/worktrees/desktop-write-patch/ruukoto/.scratch/desktop-shadcn/evidence/2026-10-16/migration-v3/output/playwright/history-after-prepend.png' });
  return { before, after, anchorPreserved: true };
}
