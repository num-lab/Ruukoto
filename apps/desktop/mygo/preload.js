(() => {
  if (window !== window.top || location.href !== "mygo://localhost/") return;
  const failure = () => ({ ok: false, error: { code: "bridge_disconnected", outcome: "disconnected", message: "MyGo 连接已关闭；请重新打开应用，原操作结果仍需核实。" } });
  const call = (method, ...args) => window.mygo.call(`Desktop.${method}`, ...args).catch(failure);
  window.ruukoto = {
    subscribe(target, listener) {
      const off = window.mygo.on("desktop:update", payload => { if (payload.target === target) listener(payload.update); });
      void call("Subscribe", target).then(result => { if (!result.ok) listener({ type: "state", state: "failed", error: result.error }); });
      return off;
    },
    request: (target, op, params) => call("Request", target, op, params),
    pickFolder: () => call("PickFolder"),
    pickSkillFolder: (target, instanceId) => call("PickSkillFolder", target, instanceId),
    pickAttachments: (sessionId, target = "code") => call("PickAttachments", sessionId, target),
    pickDraftAttachments: () => call("PickDraftAttachments"),
    uploadDraftAttachments: (sessionId, tokens, target = "code") => call("UploadDraftAttachments", sessionId, tokens, target),
    reveal: path => call("Reveal", path),
    openTerminal: (id, workspaceId, instanceId, cols, rows) => call("Request", "code", "desktop_terminal_open", { id, workspace_id: workspaceId, instance_id: instanceId, cols, rows }),
    inputTerminal: (id, data) => call("Request", "code", "desktop_terminal_input", { id, data }),
    resizeTerminal: (id, cols, rows) => call("Request", "code", "desktop_terminal_resize", { id, cols, rows }),
    killTerminal: id => call("Request", "code", "desktop_terminal_kill", { id }),
  };
  document.addEventListener("click", event => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || !event.isTrusted || !/^https?:$/.test(link.protocol)) return;
    event.preventDefault();
    void call("OpenExternal", link.href);
  }, true);
})();
