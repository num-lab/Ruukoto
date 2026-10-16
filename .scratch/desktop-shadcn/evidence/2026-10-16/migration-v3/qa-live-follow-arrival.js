async page => {
  page.setDefaultTimeout(15000);
  const scroll = page.getByRole('region', { name: '会话消息', exact: true });
  const first = scroll.getByRole('button', { name: /^Ran printf 'WORKING_FIRST_STARTED/ }).last();
  await first.waitFor();
  if (await first.getAttribute('aria-expanded') !== 'true') throw new Error('已展开工具在完成后被收起');
  await scroll.locator('[data-slot=code-block-content]').filter({ hasText: /WORKING_FIRST_STARTED\nWORKING_FIRST_DONE/ }).last().waitFor();
  await scroll.getByRole('button', { name: /^Running printf 'WORKING_SECOND_STARTED/ }).waitFor();
  await page.waitForTimeout(350);
  const geometry = await scroll.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop }));
  if (Math.abs(geometry.gap) > 2) throw new Error('结果到达时丢失末尾：' + JSON.stringify(geometry));
  await page.screenshot({ path: '/Users/eitrous/.codex/worktrees/desktop-write-patch/ruukoto/.scratch/desktop-shadcn/evidence/2026-10-16/migration-v3/output/playwright/working-result-follow-bottom.png' });
  return { geometry, openedToolResultArrivedWhileSecondRunning: true, followPreserved: true };
}
