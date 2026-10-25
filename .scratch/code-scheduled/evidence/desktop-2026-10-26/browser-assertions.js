async (page) => {
  const data = await page.evaluate(() => {
    const requests = window.__scheduledFixture.requests;
    return { saves: requests.filter(item => item.op === "code_schedule_save").map(item => item.params), controls: requests.filter(item => item.op === "code_schedule_control").map(item => item.params.control), createdSessions: requests.filter(item => ["create_session", "open_workspace"].includes(item.op)).length, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  if (data.saves.length !== 2) throw new Error("unexpected save count");
  const weekly = data.saves[0].config, once = data.saves[1].config;
  if (weekly.rule.kind !== "weekly" || JSON.stringify(weekly.rule.weekdays) !== "[1,5]" || weekly.permission !== "auto-review" || weekly.modelSelection.modelId !== "fast" || weekly.modelSelection.thinkingLevel !== "low") throw new Error("weekly form values changed");
  if (once.rule.kind !== "once" || once.rule.at !== "2030-01-02T01:30:00.000Z" || once.rule.timeZone !== "Asia/Tokyo" || once.permission !== "confirm" || once.modelSelection.thinkingLevel !== "high") throw new Error("one-shot form values changed");
  if (JSON.stringify(data.controls) !== '["pause","resume","cancel"]' || data.createdSessions !== 0 || data.horizontalOverflow) throw new Error("unexpected controls or overflow");
  return { evidence: "真实Chromium＋正式renderer；bridge为离线内存夹具", browser: page.context().browser().version(), ...data };
}
