async page => {
  page.setDefaultTimeout(10000);
  await page.waitForFunction(() => document.querySelector('.stream-scroll').querySelectorAll('[data-message-id]').length > window.__qaReadingFinalBefore.count);
  await page.waitForFunction(() => document.querySelector('.send-button')?.getAttribute('aria-label') === '发送消息');
  await page.waitForTimeout(300);
  const result = await page.locator('.stream-scroll').evaluate(el => {
    const before = window.__qaReadingFinalBefore;
    const item = [...el.querySelectorAll('[data-message-id]')].find(item => item.getAttribute('data-message-id') === before.id);
    return { before, after: { id: before.id, top: item.getBoundingClientRect().top, scrollTop: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop, count: el.querySelectorAll('[data-message-id]').length } };
  });
  if (Math.abs(result.before.top - result.after.top) > 1) throw new Error('上翻阅读被新消息抢位：' + JSON.stringify(result));
  return { ...result, freeReadingPreserved: true };
}
