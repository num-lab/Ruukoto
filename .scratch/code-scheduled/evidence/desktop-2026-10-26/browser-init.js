async (page) => {
  await page.addInitScript(() => {
    const selection = { provider: "offline", modelId: "reasoner", thinkingLevel: "high" };
    const models = [
      { provider: "offline", modelId: "reasoner", name: "Reasoner", contextWindow: 200000, maxTokens: 10000, thinkingLevels: ["off", "medium", "high"], available: true, errorCode: null },
      { provider: "offline", modelId: "fast", name: "Fast", contextWindow: 100000, maxTokens: 10000, thinkingLevels: ["off", "low"], available: true, errorCode: null },
    ];
    const workspace = { cwd: "/offline/acceptance", cwdReal: "/offline/acceptance", dev: 1, ino: 1 };
    const project = { id: "offline-workspace", name: "验收工作区", createRequestId: null, rootDir: workspace, instructionFiles: [], settingsVersion: 1, createdAt: new Date().toISOString() };
    const plans = JSON.parse(localStorage.getItem("scheduled-offline-plans") ?? "[]");
    for (const plan of plans) if (["canceled", "completed"].includes(plan.status)) plan.nextDueAt = null;
    const receipts = new Map(), listeners = new Map(), requests = [];
    let seq = 0;
    const persist = () => localStorage.setItem("scheduled-offline-plans", JSON.stringify(plans));
    const emit = plan => listeners.get("code")?.({ type: "event", kind: "live", event: { seq: ++seq, body: { type: "code_schedule.changed", plan }, sessionId: null, taskId: null, createdAt: new Date().toISOString() } });
    window.__scheduledFixture = { requests, plans };
    window.ruukoto = {
      subscribe(target, listener) {
        listeners.set(target, listener);
        setTimeout(() => {
          if (target !== "code") { listener({ type: "state", state: "failed", detail: "离线视觉验收未连接 Personal" }); return; }
          listener({ type: "snapshot", instanceChanged: false, result: { seq, replay: [], snapshot: { product: "ruukoto-code", instanceId: "offline-visual-only", projects: [project], sessions: [], tasks: [], confirmations: [], artifacts: [], previews: {}, execution: { backend: "local", note: "离线视觉夹具" }, defaultModel: { provider: "offline", id: "reasoner", name: "Reasoner", thinkingLevel: "high" }, mainSessionId: null, ownerQuestions: [], backgroundProcesses: [], codeScheduleRuns: [] } } });
          listener({ type: "state", state: "online" });
        }, 0);
        return () => listeners.delete(target);
      },
      async request(target, op, params) {
        requests.push({ target, op, params: structuredClone(params) });
        if (op === "list_models") return { ok: true, value: { models, total: 2, nextOffset: null } };
        if (op === "list_session_summaries") return { ok: true, value: [] };
        if (op === "code_schedules") return { ok: true, value: { plans: plans.filter(plan => params.scope === "history" ? ["completed", "canceled"].includes(plan.status) : ["active", "paused"].includes(plan.status)), latestRuns: [], nextOffset: null } };
        if (op === "code_schedule") return { ok: true, value: { plan: plans.find(plan => plan.id === params.plan_id), runs: [], activeRun: null, nextRunOffset: null } };
        if (op === "code_schedule_receipt") return { ok: true, value: { receipt: receipts.get(params.request_id) ?? null } };
        if (op === "code_schedule_save" || op === "code_schedule_control") {
          if (receipts.has(params.request_id)) return { ok: true, value: { kind: "accepted", requestId: params.request_id, receipt: receipts.get(params.request_id) } };
          let plan = plans.find(plan => plan.id === params.plan_id);
          const now = new Date().toISOString();
          if (plan && plan.version !== params.expected_version) return { ok: true, value: { kind: "rejected", requestId: params.request_id, code: "schedule_version_conflict", reason: "当前计划已变化" } };
          if (op === "code_schedule_save") {
            const config = structuredClone(params.config);
            const next = config.rule.kind === "once" ? config.rule.at : new Date(Date.now() + 86400000).toISOString();
            if (plan) Object.assign(plan, { config, version: plan.version + 1, nextDueAt: next, updatedAt: now });
            else { plan = { id: `offline-${plans.length + 1}`, config, workspace, version: 1, status: "active", nextDueAt: next, reason: null, createdAt: now, updatedAt: now }; plans.push(plan); }
          } else Object.assign(plan, { status: params.control === "pause" ? "paused" : params.control === "cancel" ? "canceled" : "active", version: plan.version + 1, updatedAt: now, ...(params.control === "cancel" ? { nextDueAt: null } : {}) });
          const receipt = { requestId: params.request_id, operation: op === "code_schedule_save" ? params.plan_id ? "update" : "create" : params.control, digest: "offline", plan: structuredClone(plan) };
          receipts.set(params.request_id, receipt); persist(); emit(plan);
          return { ok: true, value: { kind: "accepted", requestId: params.request_id, receipt } };
        }
        return { ok: false, error: { code: "offline_fixture", outcome: "rejected", message: "该操作不属于离线视觉验收范围" } };
      },
      async pickFolder() { return { ok: true, value: null }; },
    };
  });
  await page.goto("http://127.0.0.1:4396/");
  await page.waitForTimeout(1800);
}
