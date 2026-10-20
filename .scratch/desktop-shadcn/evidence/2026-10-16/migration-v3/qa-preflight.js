async page => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.setViewportSize({ width: 1280, height: 827 });
  return await page.evaluate(() => ({ url: location.href, scripts: [...document.scripts].map(script => script.src), css: [...document.querySelectorAll('link[rel=stylesheet]')].map(link => link.href), visible: !document.hidden, focused: document.hasFocus() }));
}
