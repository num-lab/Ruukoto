async page => {
  page.setDefaultTimeout(10000);
  await page.locator('.workspace-session').filter({ hasText: 'gui-scroll 00' }).click();
  const scroll = page.getByRole('region', { name: '会话消息', exact: true });
  await scroll.hover({ position: { x: 200, y: 200 } });
  await page.mouse.wheel(0, -3000);
  await page.waitForTimeout(500);
  return scroll.evaluate(el => {
    const item = [...el.querySelectorAll('[data-message-id]')].find(item => item.getBoundingClientRect().top >= el.getBoundingClientRect().top);
    window.__qaReadingFinalBefore = { id: item.getAttribute('data-message-id'), top: item.getBoundingClientRect().top, scrollTop: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop, count: el.querySelectorAll('[data-message-id]').length };
    if (window.__qaReadingFinalBefore.gap < 1000) throw new Error('夹具未上翻至阅读位置');
    return window.__qaReadingFinalBefore;
  });
}
