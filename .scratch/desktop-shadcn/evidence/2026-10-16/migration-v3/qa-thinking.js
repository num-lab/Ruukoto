async page => {
  page.setDefaultTimeout(10000);
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.locator('.workspace-session').filter({ hasText: 'gui-live-session' }).click();
  const input = page.getByRole('textbox', { name: '输入消息', exact: true });
  await input.fill('gui-live: Check the files');
  await input.press('Shift+Enter');
  await input.pressSequentially('and run gated commands.');
  check((await input.inputValue()).includes('\n'), 'Shift+Enter 没有换行');
  check(await page.getByRole('status', { name: 'Thinking', exact: true }).count() === 0, 'Shift+Enter 触发了发送');
  await input.press('Enter');
  const main = page.getByRole('region', { name: '会话消息', exact: true });
  await main.getByRole('status').filter({ hasText: /^Thinking$/ }).waitFor();
  check(await input.inputValue() === '', 'Enter 发送后未清空输入');
  await input.press('Enter');
  check(await main.getByRole('status').filter({ hasText: /^Thinking$/ }).count() === 1, '空 Enter 停止了任务');
  check(!(await main.innerText()).includes('Thought for'), 'Thinking 显示了思维链');
  await page.screenshot({ path: '/Users/eitrous/.codex/worktrees/desktop-write-patch/ruukoto/.scratch/desktop-shadcn/evidence/2026-10-16/migration-v3/output/playwright/thinking.png' });
  return { enterSends: true, shiftEnterNewline: true, emptyEnterDoesNotStop: true, realThinkingTail: true };
}
