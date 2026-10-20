async page => {
  page.setDefaultTimeout(10000);
  const scroll = page.getByRole('region', { name: '会话消息', exact: true });
  const geometry = () => scroll.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop }));
  const before = await geometry();
  if (before.height <= before.client || Math.abs(before.gap) > 2) throw new Error('夹具必须从溢出底部开始：' + JSON.stringify(before));
  const results = [];
  for (const label of ['收起 Working', '展开 Working']) {
    await page.evaluate(() => {
      window.__qaOverflowFrames = [];
      const started = performance.now();
      const tick = () => {
        const el = document.querySelector('.stream-scroll');
        window.__qaOverflowFrames.push({ t: performance.now() - started, top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop });
        if (performance.now() - started < 500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await scroll.getByRole('button', { name: 'Working', exact: true }).click();
    await page.waitForTimeout(550);
    const result = { label, final: await geometry(), frames: await page.evaluate(() => window.__qaOverflowFrames) };
    if (Math.abs(result.final.gap) > 2) throw new Error(label + ' 后丢失末尾：' + JSON.stringify(result));
    results.push(result);
  }
  return { before, results, overflowingWorkingCollapseFollowed: true };
}
