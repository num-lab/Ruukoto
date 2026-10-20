# Desktop 本轮迁移的隔离 Electron 验收

状态：本地隔离 Electron 验收通过；外部环境与未注入的分支见文末限制。

## 环境与内容

2026-10-16，在独立 `Ruukoto QA v3` Electron 窗口中载入正式生产构建，使用临时 Runtime／ControlServer、确定性本地 MockModelServer 与真实 local 编码 worker；所有资料、控制面与 Electron userData 都位于夹具创建的临时目录。未连接日常实例、外部模型或用户浏览器标签。CDP 只由 QA bootstrap 开启，Playwright CLI attach 后使用标准 DevTools focus emulation 使后台页继续绘制，不修改生产代码的安全配置。

首轮载入 `index-CfoZ7dF6.js`，对应 `source-hashes.json` 和 `ready-launch1.json`；该轮发现已完成工具结果的引用延迟到整批结束，故障见 `working-result-diagnostic.json` 与 `working-result-row.json`。首轮图片单独保存在 `output/playwright-launch1/`，其中 Write 图处于展开中间帧，不作为最终视觉证据。

第二轮载入 `index-Bia0QT2C.js`、`index-BpBNVmoB.css`，对应 `loaded-final.json`、`source-hashes-final.json` 与 `ready.json`。`output/playwright/` 的最终图片在目标折叠动画结束后拍摄，运行环的无限动画不等待结束。

第三轮保留同一临时后端，reload 最新生产构建，实际载入 `index-DbGskZeo.js`、`index-CTc51Tab.css`，对应 `loaded-scroll-final.json` 与 `source-hashes-scroll-final.json`；这轮专门复验消息滚动控制器的修复，未覆盖或改写前两轮依据。

验收结束后夹具以 exit 0 退出；仅本轮 Electron PID 5726 已结束，临时 userData、ControlServer 目录与工作资料均已删除，Playwright CLI 已脱离本轮连接。见 `cleanup-result.json`。

## 已验证

- 真实历史工具按实际类别分组；Read 为静态行，路径打开实际工作区文件，TypeScript 源码有高亮。Edit 与覆盖 Write 分别显示真实删除／新增行。失败 Bash 标红并显示 exit 17；失败 Read 无展开按钮且显示实际错误。完整 Bash 参数跨 64 KiB 读取，最终详情为 96,167 字符并保留尾部命令与输出。见 `history-result.json`。
- Enter 发送，Shift+Enter 换行；空 Enter 不停止运行任务。真实请求在门控模型等待时显示 Thinking，无思维链正文；释放模型后 Working 显示已完成 Read 和运行中的 Bash，工具不重复进入历史。见 `thinking-result.json` 与 `working-result.json`。
- Bash 运行时打开详情，第一工具结束而第二工具仍运行时，详情自动出现已落盘结果，无需再点击；正式控制面事件与条目对应证据另存 `working-result-diagnostic-final.json`。任务完成后尾部消失，历史只有一组。见 `working-arrival-result.json` 与 `completed-result.json`。
- 同一会话后续任务复用相同 SDK toolCallId，不继承前任务的展开状态；见 `reuse-result.json` 与 `reuse-complete-result.json`。
- 工作区和工具折叠实际产生 180 ms 动画、逐帧高度变化；筛选框有过渡、Escape 清空并归还焦点，减弱动画时关闭动画。Tab hover 关闭键叠加且宽度不变，文本渐变；选中 tab 两端无分隔线，消息流／右栏顶部之间为 28 px 短竖线。833 px 窄栏底部功能键同排，模型收为图标；明暗主题通过。见 `layout-result.json`。
- 实际外部文件审批期间无 Thinking／Working 尾部，拒绝后继续；下一审批任务可停止，结束后无残留尾部。见 `approval-result.json` 与 `stop-result.json`。首轮审批因夹具未规范化 /var 别名被工具拒绝，不计作审批验收，第二轮已修正后重验。
- 第三轮先选择长历史会话，初始 top=0、底部 gap=9042，证明从开头显示而非自动跳末尾；从 50 条补至 62 条，同一阅读锚点 108.75→108.5 px。随后真实 wheel 上翻，新任务使 66→68 条时可见锚点始终为 293.25 px，阅读位置未被新消息拉走。见 `initial-start-result.json`、`scroll-final-result.json` 与 `scroll-reading-final-result.json`。
- 第三轮真实 wheel 到末尾后，连续提交两次新任务，消息数 62→64→66，两个终态底部 gap 均为 0。Working 中展开运行 Bash，内容从不溢出变为 height734／client651，仍保持 gap=0；第一工具结果到达、第二工具仍运行时 height841，gap=0.5。溢出状态下收起 Working，height841→651、gap=0；再展开恢复 height841、gap=0.5。工具批次结束转为历史后 gap=0，执行尾部消失。每次收展采集 31 帧，见 `scroll-follow-final-result-1.json`、`scroll-follow-final-result-2.json` 与 `working-scroll-{follow,arrival,collapse,complete}-result.json`。

## 修复依据与截图

第二轮真实 wheel 滚到末尾后，新任务曾残留 69 px。`scroll-event-diagnostic.json` 记录可信 wheel／scroll、MutationObserver 与 ResizeObserver 的顺序：第二次内容占位高度上升后先收到 scroll，旧几何阈值关闭跟随，再次 resize 未跟到末尾。`scroll-follow-result.json` 保留为失败记录；第三轮在改用官方滚动控制器后完成上述复验。首轮工具结果引用延迟的问题也保留原始诊断，以第二轮和第三轮的新证据证明修复。

最终选图如下，路径均相对于本证据目录；第二轮图证明各 UI 行为，第三轮图证明滚动增量。每张图的 SHA-256 见 `screenshots.json`。

| 截图 | 轮次 | 验收内容 |
| --- | --- | --- |
| `output/playwright/read-file-highlight.png` | 第二轮 | Read 路径与实际源码高亮 |
| `output/playwright/inline-edit-write.png` | 第二轮 | 完整展开后的 Edit／覆盖 Write 增删行 |
| `output/playwright/failed-tools.png` | 第二轮 | 失败 Bash／Read 与错误详情 |
| `output/playwright/tab-hover-dark.png` | 第二轮 | 关闭键叠加、文本渐变与短分隔线 |
| `output/playwright/narrow-dark.png` | 第二轮 | 窄栏功能键同排与模型图标 |
| `output/playwright/light.png` | 第二轮 | 明亮主题 |
| `output/playwright/thinking.png` | 第二轮 | 真实请求等待期间 Thinking |
| `output/playwright/working-running.png` | 第二轮 | 已完成 Read 与运行中的 Bash |
| `output/playwright/working-result-arrival.png` | 第二轮 | 工具 1 结果到达时工具 2 仍运行 |
| `output/playwright/approval.png` | 第二轮 | 实际审批期间无误导执行尾部 |
| `output/playwright/history-after-prepend.png` | 第三轮 | 补页保留阅读锚点 |
| `output/playwright/history-follow-bottom.png` | 第三轮 | 连续新任务后仍在末尾 |
| `output/playwright/working-scroll-follow.png` | 第三轮 | 运行详情展开后末尾跟随 |
| `output/playwright/working-result-follow-bottom.png` | 第三轮 | 结果到达、下一工具运行时末尾跟随 |

## 限制

跨父会话的截断 Read 迟到响应、未知效果与失败 Agent 分支由根代理的定向用例证明；本次未单独构造相应 Electron 故障注入。真实外部模型、SSH、原生沙箱权限和系统截图／键盘前台能力不在这份本地 UI 夹具的验收结论内。
