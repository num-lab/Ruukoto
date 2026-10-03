Status: ready-for-agent

# 02 — 工作进程启动失败时后台崩溃或空等 30 秒，而不是明确报错

**What to fix:** 受限模式的执行入口不可用时，要立即以 `execution_unavailable` 拒绝该次工具调用，后台进程不能因此退出。

## 现状与证据

1. **docker 命令找不到 → 后台进程退出。**
   - `src/agent/execution/launchers.ts`：容器启动器用 `spawn(config.dockerPath, …)` 启动工作进程，完全访问启动器用 `spawn(entry.sudoPath, …)` 启动；`toExitPromise` 只挂了 `exit` 监听，没有任何地方监听子进程的 `error` 事件（`tool-worker/host.ts` 里也没有）。
   - 后台（`ruukoto server`）没有注册 `uncaughtException`；全仓只有 tui、config-tui 和 worker 注册了。
   - 默认 `dockerPath` 是裸命令 `docker`。它不在 PATH 上时，spawn 发出 ENOENT 的 `error` 事件，没有人处理，Node 会抛出 `Unhandled 'error' event`，进程以退出码 1 结束。
   - 已用 Node v24.15.0 的最小脚本复现这条语义；没有在产品里实测。sudo 包装路径不存在时同理。
2. **dockerd 不可用或镜像缺失 → 等 30 秒才报 `worker_timeout`。**
   - `tool-worker/host.ts` 的构造函数里，`exit` 只用于让在途调用失败（`failAllPending`）。`readyPromise` 只认三种结果：ready 帧、fatal 帧、30 秒超时。
   - 所以 docker CLI 存在、容器却立即退出时，要等满 30 秒才报 `worker_timeout`，而不是马上给出启动失败的原因。
3. **对照**：只有带路径的 `RUUKOTO_DOCKER_PATH` 指向不存在的文件时，现在会明确报 `execution_unavailable`。ADR 0017、`docs/runtime.md` 与 agent-direction 工单 04 都写着「受限后端缺失时首个工具调用以 `execution_unavailable` 拒绝」，只覆盖了这一种情况。

来源：2026-10-03 可视化文档核查（deployment.html）；主代理复核了代码，并复现了 Node 行为。

## 验收标准

- [ ] 所有启动器的子进程都处理 `error` 事件：spawn 失败转成 `ExecutionError("execution_unavailable", …)`，交回本次工具调用，后台进程保持运行。
- [ ] 工作进程在发出 ready 之前退出时，`readyPromise` 立即失败，失败信息带上退出码与已收到的 stderr 尾部，不再等满 30 秒。
- [ ] 测试覆盖三种情况，断言结局是明确的错误且后台仍可接受新任务：dockerPath 为不存在的裸命令名、dockerPath 为不存在的绝对路径、容器启动后立即退出。
- [ ] 确认后台是否需要一个只记录、不吞错的 `uncaughtException` 兜底。不需要的话在工单里写明理由。
- [ ] 同步 `docs/visual/deployment.html`「执行边界」与 `tool-call-path.html`「执行边界」里「明确失败的时点」的说法，以及 runtime.md 的对应描述。
