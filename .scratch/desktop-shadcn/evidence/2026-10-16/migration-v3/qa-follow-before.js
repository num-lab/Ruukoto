async page => {
  page.setDefaultTimeout(10000);
  await page.locator('.workspace-session').filter({ hasText: 'gui-scroll 00' }).click();
  const scroll = page.getByRole('region', { name: '会话消息', exact: true });
  await page.waitForTimeout(500);
  await scroll.hover({ position: { x: 200, y: 200 } });
  await page.mouse.wheel(0, 20000);
  await page.waitForTimeout(300);
  const before = await scroll.evaluate(el => {
    window.__qaFollowFinalBefore = { gap: el.scrollHeight - el.clientHeight - el.scrollTop, count: el.querySelectorAll('[data-message-id]').length };
    return window.__qaFollowFinalBefore;
  });
  if (before.gap > 2) throw new Error('夹具未滚到真实末尾：' + JSON.stringify(before));
  return before;
}
