async page => {
  await page.unroute('**/spotlight-fixture.js*');
  await page.route('**/spotlight-fixture.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/(['"])当前开发\1/, "'ping'").replace(/(['"])古早聊天\1/, "'ping'").replace(/(['"])蓝色灯塔\1\.includes\(params\.query\)/, "'ping'.includes(params.query)").replace("snippet: entries[1].text", "snippet: 'ping'");
    await route.fulfill({ response, body });
  });
  await page.goto('http://127.0.0.1:4318/output/playwright/spotlight.html');
  await page.getByRole('button', { name: '搜索 Code 工作区', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索 Code 会话与聊天内容' }).fill('in');
  await page.locator('.search-message-option').waitFor();
  const measurements = await page.locator('.search-option').evaluateAll(options => options.map(option => {
    const mark = option.querySelector('mark');
    if (!mark || !(mark.previousSibling instanceof Text) || !(mark.nextSibling instanceof Text)) throw new Error('夹具须包含匹配串前后的文字');
    const before = document.createRange();
    const after = document.createRange();
    before.selectNodeContents(mark.previousSibling);
    after.selectNodeContents(mark.nextSibling);
    return { kind: option.classList.contains('search-message-option') ? 'message' : 'session', archived: !!option.querySelector('[data-slot="badge"]'), text: mark.previousSibling.textContent + mark.textContent + mark.nextSibling.textContent, beforeGap: mark.getBoundingClientRect().left - before.getBoundingClientRect().right, afterGap: after.getBoundingClientRect().left - mark.getBoundingClientRect().right };
  }));
  if (measurements.length !== 3 || measurements.some(item => item.text !== 'ping' || Math.abs(item.beforeGap) > 0.5 || Math.abs(item.afterGap) > 0.5)) throw new Error(JSON.stringify(measurements));
  return { passed: true, measurements };
}
