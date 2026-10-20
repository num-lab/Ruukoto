async page => {
  page.setDefaultTimeout(15000);
  await page.locator('.workspace-session').filter({ hasText: 'gui-approval-session' }).click();
  const stream = page.getByRole('region', { name: '会话消息', exact: true });
  const approve = stream.getByRole('button', { name: '批准', exact: true });
  await approve.waitFor();
  if (await stream.getByRole('status').count()) throw new Error('审批期间仍显示执行尾部');
  await page.screenshot({ path: '/Users/eitrous/.codex/worktrees/desktop-write-patch/ruukoto/.scratch/desktop-shadcn/evidence/2026-10-16/migration-v3/output/playwright/approval.png' });
  await stream.getByRole('button', { name: '拒绝', exact: true }).click();
  await stream.getByText('APPROVAL_COMPLETE', { exact: true }).waitFor();
  return { realApprovalSuppressesExecutionTail: true, rejectProcessed: true };
}
