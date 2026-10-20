async page => {
  page.setDefaultTimeout(10000);
  await page.waitForFunction(() => document.querySelector('.stream-scroll').querySelectorAll('[data-message-id]').length > window.__qaFollowFinalBefore.count);
  await page.waitForFunction(() => document.querySelector('.send-button')?.getAttribute('aria-label') === '发送消息');
  await page.waitForTimeout(300);
  const after = await page.locator('.stream-scroll').evaluate(el => ({ gap: el.scrollHeight - el.clientHeight - el.scrollTop, count: el.querySelectorAll('[data-message-id]').length, top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
  if (after.gap > 2) throw new Error('任务完成后末尾仍未跟随：' + JSON.stringify(after));
  await page.screenshot({ path: '/Users/eitrous/.codex/worktrees/desktop-write-patch/ruukoto/.scratch/desktop-shadcn/evidence/2026-10-16/migration-v3/output/playwright/history-follow-bottom.png' });
  return { before: await page.evaluate(() => window.__qaFollowFinalBefore), after, followedAfterMessageAndLazyMeasure: true };
}
