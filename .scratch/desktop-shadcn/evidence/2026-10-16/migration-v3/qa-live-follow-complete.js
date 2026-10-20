async page => {
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => document.querySelector('.send-button')?.getAttribute('aria-label') === '发送消息');
  await page.waitForTimeout(350);
  const scroll = page.getByRole('region', { name: '会话消息', exact: true });
  if (await scroll.getByRole('status').filter({ hasText: /^(Thinking|Working)$/ }).count()) throw new Error('结束后仍有执行尾部');
  const geometry = await scroll.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop }));
  if (Math.abs(geometry.gap) > 2) throw new Error('转为终态历史时丢失末尾：' + JSON.stringify(geometry));
  return { geometry, completedTailRemoved: true, followPreserved: true };
}
