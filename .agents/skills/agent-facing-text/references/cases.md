# 案例：一次本地网页测试中的连续误调

案例记录的是 `c1f5041` 时的行为。来源会话 `2026-10-14T06-22-58-602Z`，调用序列与可复现证据见[诊断](../../../../.scratch/agent-browser/evidence/owner-session-diagnosis.md)，此处不复制会话正文。规则编号对应 [SKILL.md](../SKILL.md)。

本文件不交给盲审者；盲审只用 `SKILL.md` 衡量 skill 能否独立挑出这些缺陷。新增遗漏时回 `SKILL.md` 补一般规则，不在这里加案例。

| # | 现象 | 文本缺陷 | 规则 |
| --- | --- | --- | --- |
| 1 | `open file://…` 返回 `invalid_params` | 只支持 http/https 只在校验代码里（`browser-tools.ts` 的 `parseBrowserParams`）；`url` 参数没有描述 | J1 |
| 2 | `nohup … &` 起的 http.server 随调用返回被杀；改双 fork 后 bash 等管道 600 秒超时 | bash 描述没写后台子进程的回收时机与返回条件 | J7 |
| 3 | `outcome_unknown` 提示「请核实当前页面」，接着 `tabs list` 得到 `browser_not_ready` | 提示要求做当前状态下做不到的事 | J2、J3 |
| 4 | `browser_not_ready` 提示「请先核实原执行并显式关闭」 | 「核实原执行」没有对应工具，属内部术语 | J2 |
| 5 | `resume` 返回 `browser_paused` | 描述已写「新消息的新任务才能 resume」，但把 pause 写成人工登录专用，没说 `outcome_unknown` 且状态为 unavailable 时宿主会自动 pause | J3 |
| 6 | `close` → `start` 后又发了一次 `open` | 「结果未知时不重发」只有禁令，没给正面做法，也没说重建会话后是否仍适用 | J4 |
| 7 | 模型读 `browser-manager.ts` 推断恢复流程，约 12 次调用 | 第 3–6 条的后果，不单独计 | — |
| 8 | `status`/`start`/`close` 每次返回约 1.4 KB binding JSON | 结果含 pid、pgid、socketDir、cdpUrl 等实现细节 | J5 |
| 9 | 模型花一段推理判断自己是 main 还是 dev 会话 | 描述写了模型无法影响、且满足才装配的资格限制 | J8 |
| 10 | 每次 bash 结果都附「[完整正文已捕获：artifact …]」，4 字节输出也不例外 | 无条件追加的提示（`tool-router.ts` 的结果追加段） | J6 |

第 2 条：[bash 后台生命周期提案](../../../notes/proposed/feature/2026-10-14-bash-background-lifecycle.md)拟改变「返回即回收」，落地后本条的现象会变，归类仍是 J7。

第 2 条之外，`outcome_unknown` 本身不是缺陷：上游导航失败不给结构化错误码，管理器按不重发契约保守冻结，见诊断「结论」。

## 改前／改后示意

只示意规则怎么落到文本上，不是修复方案；实际修复另开工单，按 `SKILL.md` 审过再定。

1. 改前：`url` 参数无描述。改后：`url`：网页地址，只接受 http 或 https；本地文件先用本地 HTTP 服务提供。
2. 改前：「在工作区执行 bash 命令」。改后：补一句「命令返回时回收它启动的全部后台子进程；需要常驻的服务另行启动」（以提案落地后的实际行为为准）。
3. 改前：「已暂停自动化，请核实当前页面」。改后：「已暂停自动化；本状态下只能 close 或报告拥有者」。
4. 改前：「请先核实原执行并显式关闭」。改后：「先 close 关闭当前浏览器；无法关闭时停下来报告拥有者」。
5. 改前：「人工登录先 pause」。改后：「pause 用于人工登录；动作结果未知时宿主也会自动 pause。暂停期间只有拥有者的新消息能恢复，本任务内 resume 会被拒」。
6. 改前：「结果未知时不重发」。改后：「结果未知时不重发同一动作；先取快照确认页面状态。close 后重新 start 的新会话不受此限」。
8. 改前：`status` 返回整份绑定记录。改后：只返回状态与当前标签标识。
9. 改前：「仅完全访问的拥有者 main/普通开发会话」。改后：删去，工具出现即已满足。
10. 改前：每次结果都追加捕获提示。改后：只在输出被截断时追加「已截断，完整输出可用 read_artifact 继续读取」。
