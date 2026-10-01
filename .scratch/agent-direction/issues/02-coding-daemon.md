Status: resolved

# 02 — 打开 TUI 时启动后台，退出后继续任务

**What to build:** 拥有者直接启动 Coding Agent 即可进入任务界面，后台按需启动；关闭、重连和显式停止都有明确行为。

**Blocked by:** [01 — 两个产品独立安装和启动](01-independent-products.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 后台不存在时按需拉起；同时打开两个终端只形成一个对应实例的后台。
- [x] 关闭 TUI 不取消任务，再次打开能看到同一任务和结果，不重复提交。
- [x] 显式停止只作用于指定产品实例；后台不可用、启动失败和不兼容版本给出明确状态。
- [x] 沿用后台异常中断后的记录恢复与人工继续规则，不把连接丢失当作重新执行授权。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-02：实施完成

**实现方式**

- 新模块 `src/control/ensure-backend.ts`：
  - `probeControlPlane` 自 `src/dev.ts` 迁入（dev.ts 再导出，既有测试接缝不变），socket 可连 + 令牌认证握手通过才算在运行；
  - `ensureBackend`：探测通过直接复用；socket 可连但认证不通过 → 后台其实在运行，直接给出令牌核对指引、不再拉起；确实不在才 spawn detached + unref 的 `server` 子进程（输出追加到 `<controlDir>/spawn.log`），轮询探测到就绪。并发拉起不设客户端锁：两进程竞跑由后台实例锁（`<dataDir>/runtime.lock`）收敛，败者带 InstanceLockError 退出；日志尾部命中实例锁冲突即继续探测到总截止，连到胜者按复用进入（spawned=false，不算本进程拉起），不误判启动失败；
  - 失败分类明确：非锁原因的子进程提前退出+宽限窗口耗尽 → 「后台启动失败」附 spawn.log 尾部；尾部是 no_model 时追加「先运行 ruukoto-dev config」提示；总超时单独标注且不杀进程（胜者可能仍在就绪途中）；
  - `tuiSpawnsBackendOnDemand` 门控只属 ruukoto-dev；ruukoto（个人 Agent）沿用显式 `server`/systemd，TUI 不越权拉起。
- TUI 接线（`src/tui/index.ts` runTui）：ruukoto-dev 在解析客户端配置前按需拉起；成功且本进程拉起时打印一行提示，失败打印错误且非零退出。demo 会话与开发实例（`npm run dev`）不受影响。生产默认 spawn 参数由 `process.argv[1]` 推导（bin 入口自身 `server --data-dir … --agent-dir …`），冒烟正是覆盖这条默认路径。
- 未改动既有规则（交由回归证明）：连接层重连只恢复观察、绝不再次拉起；关闭 TUI 不发 stop、不取消任务（`TuiApp.quit` 注释即此约束）；显式 `stop` 只经本产品 socket（issue 01 已验证）；拉起即正常 `server` 启动，`Runtime.recover()` 的 interrupted/暂停队列/效果未知不重放原样生效。

**验证（模拟与真实环境分列）**

- 类型检查：`npx tsc --noEmit` 通过。
- 新增 `test/72-on-demand-backend.test.ts`（8/8 通过，真实 bin 后台进程/真实文件/socket/SQLite，模型打桩）：门控（只有 ruukoto-dev 按需拉起）、后台不在时拉起单实例并可认证握手（实例锁 owner 为活进程）、两个终端并发拉起握手同一数据实例、已运行快速复用且实例标识不变、无模型配置启动失败附 spawn.log 尾部（no_model 实际错误 + ruukoto-dev config 提示）且不留可连接后台、关闭客户端不停止后台或取消任务（重开快照见同一完成任务、`find_task` 幂等键仍指原任务）、锁竞败者等慢胜者就绪并复用（spawned=false，不误判启动失败）、后台在运行但令牌不符时给出认证指引且不重复拉起。前后台同属 macOS 本机真实进程与文件——模拟的只有模型层。
- 回归：01/02/04/12/29/32/71 共 69 项通过（实例锁、幂等提交与重连、崩溃恢复、连接恢复与待确认、CLI 入口、dev 实例、双产品并存与独立停止）。
- 全套 `npm test`：710 项中 707 通过，仅余 main 上既有的 2 项失败（13-tui-state accessModeLabel、19-tui-demo usage 事件覆盖——已在干净 HEAD 复现确认，与本单无关，沿 issue 01 记录另行处理）。
- 真实环境（macOS 本机，真实 pty/真实 bin/文件/socket/SQLite；models.json 结构合法指向死端口、冒烟不发生模型调用）：`.scratch/agent-direction/smoke-02.sh` 5/5 通过——①pty 下真实 `runTui` 生产默认路径首次按需拉起、打印提示、Ctrl+C 路径退出后 socket 存活（后台不停）且 spawn.log 在；②再开 TUI 复用不重复拉起；③`ruukoto-dev stop` 后 socket 消失；④停止后重开再次按需拉起（实例锁接管，升级换新代码同路径）；⑤空档案根启动失败：非零退出 + 「后台启动失败」+ spawn.log 尾部实际错误。冒烟 pty 运行器为 `.scratch/agent-direction/pty-run.py`（GRACE 秒后发 SIGTERM 走 app.quit 同路径）。
- 不兼容版本状态：沿用既有协议拒绝路径（`protocol_version` → 终止重连的「离线」态并给出升级指引），回归测试覆盖；这不属于拉起能解决的问题，规格的三类状态（后台不可用/启动失败/不兼容版本）分别在拉起失败态、退避重连态、协议拒绝态呈现。
- 文档同步：`docs/runtime.md`（ruukoto-dev 行为差别新增按需拉起条目、「按需拉起后台」专节、崩溃恢复第 1 条纳入 TUI 拉起竞跑、部署节说明无服务单元与升级、验证状态诚实清单新增两行）、`docs/visual/`（control-protocol 连接状态机按拉起/重连分拆、deployment 进程拓扑新增「ruukoto-dev：没有服务单元，TUI 按需拉起」、storage-layout 控制目录补 spawn.log、task-lifecycle 重启恢复纳入拉起入口）；`npx tsx --test test/67-visual-docs.test.ts` 通过。

**取舍说明**

- 拉起只发生在 TUI 启动时一次；运行中断线仍按既有规则退避重连、不自动重拉（重开 TUI 即重新拉起）——与「连接丢失不是重新执行授权」一致，也避免重连风暴里反复拉起。
- 首次使用未配置模型时，按需拉起以「后台启动失败 + 日志尾部（未找到可用模型）」结束并提示先 `ruukoto-dev config`；不做 TUI 内拉起中/拉起失败的状态机扩展（YAGNI：失败即退出，修复后重开即可）。
