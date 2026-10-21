async page => {
  let omitDetails = false;
  await page.unroute('**/spotlight-fixture.js*');
  await page.route('**/spotlight-fixture.js*', async route => {
    const response = await route.fetch();
    let body = (await response.text()).replace(/(['"])当前开发\1/, "'needle ' + '很长的会话名称 '.repeat(40)").replace(/(['"])古早聊天\1/, "'needle ' + 'VeryLongSessionName'.repeat(40)").replace(/params\.query\.toLowerCase\(\) === (["'])needle\1/, "(params.query.toLowerCase() === 'needle' || params.query.toLowerCase() === 'in')").replace("snippet: entries[1].text", "snippet: params.query === 'in' ? 'ping' : '…' + '前文'.repeat(40) + '😀needle ' + '很长的正文预览 '.repeat(60) + '\\n第二段正文'");
    if (omitDetails) body = body.replace(/timestamp:\s*at\(3\),\s*snippet:/, 'timestamp: null, snippet:').replace('archivedAt: s.archivedAt', 'archivedAt: null');
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => { Date.now = () => Date.UTC(2026, 9, 22, 0, 0, 3); });
  const results = [];
  for (const width of [1280, 400]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('http://127.0.0.1:4318/output/playwright/spotlight.html');
    await page.getByRole('button', { name: '搜索 Code 工作区', exact: true }).click();
    await page.getByRole('combobox', { name: '搜索 Code 会话与聊天内容' }).fill('needle');
    await page.locator('.search-message-option').waitFor();
    await page.waitForFunction(() => { const box = document.querySelector('.search-dialog').getBoundingClientRect(); return Math.abs(box.width - Math.min(640, innerWidth - 32)) < 1 && box.left >= 15 && box.right <= innerWidth - 15; }, null, { timeout: 3000 });
    const rows = await page.locator('.search-option').evaluateAll(options => options.map(option => {
      const message = option.classList.contains('search-message-option');
      const contents = option.querySelector('.search-option-text');
      const heading = contents.firstElementChild;
      const name = heading.querySelector('.search-snippet');
      const workspace = contents.querySelector('small');
      const snippet = contents.querySelector('.search-preview');
      const time = option.querySelector('time');
      const badge = option.querySelector('[data-slot="badge"]');
      const bounds = option.getBoundingClientRect();
      const single = (element, overflow = 'ellipsis') => { const style = getComputedStyle(element); return style.textOverflow === overflow && style.whiteSpace === 'nowrap' && element.getBoundingClientRect().height <= parseFloat(style.lineHeight) + 1; };
      const visible = element => { const rect = element.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom; };
      const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-1, 'day');
      const timeVisible = !message || !!time && time.textContent === relative && time.title === new Date(time.dateTime).toLocaleString() && time.scrollWidth <= time.clientWidth + 1 && visible(time) && time.getBoundingClientRect().left >= contents.getBoundingClientRect().right;
      const twoLines = !message || !!snippet && single(snippet, 'clip') && snippet.scrollWidth > snippet.clientWidth && snippet.getBoundingClientRect().top >= heading.getBoundingClientRect().bottom;
      const mark = snippet?.querySelector('mark');
      const markVisible = !message || !!mark && mark.textContent === 'needle' && mark.getBoundingClientRect().left >= snippet.getBoundingClientRect().left && mark.getBoundingClientRect().right <= snippet.getBoundingClientRect().right;
      const centered = !message || !!mark && Math.abs(mark.getBoundingClientRect().left + mark.getBoundingClientRect().width / 2 - snippet.getBoundingClientRect().left - snippet.clientWidth / 2) <= 1;
      return { kind: message ? 'message' : 'session', nameSingle: single(name), workspaceCorrect: message ? workspace === null : !!workspace && single(workspace), fieldWidths: [name.clientWidth, ...(workspace ? [workspace.clientWidth] : [])], nameClipped: name.scrollWidth > name.clientWidth, badgeVisible: !badge || visible(badge), timeVisible, relativeTime: time?.textContent ?? null, twoLines, markVisible, centered, overflow: contents.scrollWidth > contents.clientWidth + 1 };
    }));
    const result = { width, panel: await page.locator('.search-dialog').boundingBox(), rows };
    results.push(result);
    if (rows.length !== 3 || rows.some(row => !row.nameSingle || !row.workspaceCorrect || row.fieldWidths.some(size => size < 22) || !row.nameClipped || !row.badgeVisible || !row.timeVisible || !row.twoLines || !row.markVisible || !row.centered || row.overflow)) throw new Error(JSON.stringify(result));
  }
  const resized = [];
  for (const width of [1280, 400]) {
    await page.setViewportSize({ width, height: 720 });
    await page.waitForFunction(() => {
      const panel = document.querySelector('.search-dialog').getBoundingClientRect();
      const preview = document.querySelector('.search-preview'), mark = preview.querySelector('mark');
      return Math.abs(panel.width - Math.min(640, innerWidth - 32)) < 1 && Math.abs(mark.getBoundingClientRect().left + mark.getBoundingClientRect().width / 2 - preview.getBoundingClientRect().left - preview.clientWidth / 2) <= 1;
    }, null, { timeout: 3000 });
    resized.push({ width, panel: await page.locator('.search-dialog').boundingBox(), scrollLeft: await page.locator('.search-preview').evaluate(node => node.scrollLeft) });
  }
  await page.screenshot({ path: 'output/playwright/spotlight-result-layout.png', scale: 'css' });
  omitDetails = true;
  await page.reload();
  await page.getByRole('button', { name: '搜索 Code 工作区', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索 Code 会话与聊天内容' }).fill('needle');
  await page.locator('.search-message-option').waitFor();
  const optional = await page.locator('.search-message-option').evaluate(option => ({ workspace: option.querySelector('small')?.textContent, time: option.querySelectorAll('time').length, badges: option.querySelectorAll('[data-slot="badge"]').length, overflow: option.querySelector('.search-option-text').scrollWidth > option.querySelector('.search-option-text').clientWidth + 1 }));
  if (optional.workspace !== undefined || optional.time !== 0 || optional.badges !== 0 || optional.overflow) throw new Error(JSON.stringify(optional));
  await page.getByRole('combobox', { name: '搜索 Code 会话与聊天内容' }).fill('in');
  await page.waitForFunction(() => document.querySelector('.search-preview')?.textContent?.includes('in'));
  const short = await page.locator('.search-preview').evaluate(node => ({ text: node.textContent, left: node.scrollLeft, fits: node.scrollWidth <= node.clientWidth, mark: node.querySelector('mark')?.textContent }));
  if (short.text !== 'ping' || short.left !== 0 || !short.fits || short.mark !== 'in') throw new Error(JSON.stringify(short));
  return { passed: true, results, resized, optional, short };
}
