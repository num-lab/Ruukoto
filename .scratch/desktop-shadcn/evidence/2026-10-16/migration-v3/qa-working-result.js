async page => {
  page.setDefaultTimeout(15000);
  const main = page.getByRole('region', { name: '会话消息', exact: true });
  await main.getByRole('status').filter({ hasText: /^Working$/ }).waitFor();
  const first = main.getByRole('button', { name: /^Ran printf 'WORKING_FIRST_STARTED/ });
  await first.waitFor();
  if (await first.getAttribute('aria-expanded') !== 'true') throw new Error('已打开详情在工具完成后收起');
  await main.locator('[data-slot=code-block-content]').filter({ hasText: /WORKING_FIRST_STARTED\nWORKING_FIRST_DONE/ }).waitFor();
  await main.getByRole('button', { name: /^Running printf 'WORKING_SECOND_STARTED/ }).waitFor();
  await page.waitForTimeout(230);
  await page.screenshot({ path: '/Users/eitrous/.codex/worktrees/desktop-write-patch/ruukoto/.scratch/desktop-shadcn/evidence/2026-10-16/migration-v3/output/playwright/working-result-arrival.png' });
  return { openedRunningToolAutomaticallyReceivedResult: true, sameBatchSecondToolStillRunning: true };
}
