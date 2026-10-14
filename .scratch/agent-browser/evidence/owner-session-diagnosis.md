# 拥有者真实会话的浏览器失败诊断

日期：2026-10-14。来源为拥有者提供的开发实例会话 `2026-10-14T06-22-58-602Z_4f411b02-1208-4044-ab77-6b10a9fe1a5f.jsonl`，初始失败窗口固定为前 45 行；后续成功以本次读取的前 71 行为准。这里只记录调用和失败信号，不复制网页、截图、模型配置或凭据。

## 结论

主要原因是模型通过 bash 的 `nohup python3 -m http.server … &` 启动了临时服务器，该服务器随主 Shell 退出被工具 worker 回收。第一次同命令内 curl 返回 200，只证明服务器当时可用；后续独立 curl 返回 000，进程查询找不到 http.server。两次 browser HTTP open 分别在约 46 / 70 毫秒内返回 `outcome_unknown`。上游导航失败没有结构化错误码，管理器按既有不重发契约保守冻结；后续 `browser_not_ready` 和 `browser_paused` 是保护状态的连带拒绝。

第一次 file URL 被 `invalid_params` 拒绝，属于只开放 HTTP/HTTPS 的参数约定。实际 prompt 中 browser 的 description 和 url schema 没有说明这个前提；bash description 也没有说明每条命令返回后回收后台子进程。模型接口说明存在缺口，不能把全部失败归因于模型无视指示。

最新快照共有 16 次 browser 结果：成功 11 次，`invalid_params` 1 次，`outcome_unknown` 2 次，`browser_not_ready` 1 次，`browser_paused` 1 次。后续服务器存活后 HTTP open 成功、两次 screenshot 成功并各含一个图片块；这份会话没有持续的浏览器启动或截图故障。该成功只证明工具返回视觉块，不额外声称模型视觉判断或人工登录已验收。

## 可复现证据

`npx tsx /tmp/ruukoto-browser-bash-repro.mts` 通过真实 `ToolWorkerHost` 和完全访问 launcher 连续两次核实：同一次 bash 内 HTTP 200，调用返回时服务器 PID 已不存在，随后 HTTP 请求为 `ECONNREFUSED`。探针使用独立临时目录和合成页面，结束核实 worker 停止并删除临时目录；没有操作拥有者的后台、服务器或 Chrome。

独立上下文运行 `/tmp/ruukoto-browser-review/navigation-diagnosis.mts`，使用固定官方 v0.39.1 和隔离 Chrome/profile：持续存活的合成服务器使 native 和 Manager open 均成功；无监听端口使 native 在 12 毫秒内返回 exit 1、success false、文本信号 `ERR_CONNECTION_REFUSED`，没有结构化 code；Manager 在 31 毫秒内返回 `outcome_unknown`、effectUnknown true、state unavailable，随后 tabs 返回 `browser_not_ready`、effectUnknown false。所有探针绑定均核实关闭。

归属实现见 [worker](../../../packages/agent/src/tool-worker/worker.ts) 的主 Shell 退出回收；导航失败归类见 [browser-manager](../../../packages/agent/src/browser-manager.ts) 的 `responseError` / `command`；URL 参数和模型说明见 [browser-tools](../../../packages/agent/src/browser-tools.ts)，bash 模型说明见 [tool-router](../../../packages/agent/src/tool-router.ts)。没有通过解析上游诊断文本放宽 `outcome_unknown` 或自动重试。

## 下一步

人工验收按拥有者要求挂起，等待 [bash 后台生命周期问题](../../../.agents/notes/proposed/feature/2026-10-14-bash-background-lifecycle.md)解决并通过对应回归与真实执行验收后，再恢复原浏览器验收清单。独立终端持续运行 HTTP 服务仍是现有可选办法，不作为本轮继续人工验收的要求。模型工具说明的 URL 前提与 bash 后台进程生命周期仍待补齐；本次没有修改执行规则，原有工程证据继续对应原实现。
