async page => {
  page.setDefaultTimeout(15000);
  const check = (value, message) => { if (!value) throw new Error(message); };
  const main = page.getByRole('region', { name: '会话消息', exact: true });
  await main.getByRole('status').filter({ hasText: /^Working$/ }).waitFor();
  const item = main.locator('[data-slot=message-scroller-item]').last();
  check(await item.getByRole('link', { name: '打开文件 src/lib/sync/indexeddb.ts', exact: true }).count() === 1, 'Working 没显示已完成 Read');
  check(await main.getByRole('link', { name: '打开文件 src/lib/sync/indexeddb.ts', exact: true }).count() === 1, 'Working 工具重复显示在历史');
  await item.getByRole('button', { name: /^Running printf 'WORKING_FIRST_STARTED/ }).click();
  await item.locator('[data-slot=code-block-content]').filter({ hasText: 'WORKING_FIRST_STARTED' }).waitFor();
  await page.waitForTimeout(230);
  await page.screenshot({ path: '/Users/eitrous/.codex/worktrees/desktop-write-patch/ruukoto/.scratch/desktop-shadcn/evidence/2026-10-16/migration-v3/output/playwright/working-running.png' });
  return { workingTail: true, completedReadRow: true, runningBashExpanded: true, noDuplicateHistoryRows: true };
}
