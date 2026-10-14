# agent-browser 首版独立实现审查

对象：main 工作区 browser-tools.ts、driver.ts、runtime.ts、tool-availability.ts、browser-manager.ts、process-identity.ts、instance-lock.ts 及相连 core 事件读取。审查者只读 main；所有反例和平台替身写在本临时目录。依据为工单 01 当前首版契约、development-workflow 与 error-handling；作者总结仅作导航。

最终结论：冻结生产源码范围内无未解决实现阻断。已复现的实现缺陷均由 root 修正并经审查者亲自复核，新发现对应的正式回归也已入库、独立执行通过。审查只对 reviewed-sha256.txt 的源码和测试有效；真实模型与拥有者人工产品验收不在本审查的通过范围；其实际结果由实施者另行记录。Linux 真实平台校准使用临时系统库、显式 no-sandbox 与 shm profile，不证明 tx 生产前提满足。

## 发现与复核

| 问题和触发 | 违反契约 | 原证据 | 当前结果 |
| --- | --- | --- | --- |
| 排队 B 模式切换关闭同会话正在执行 A 的浏览器 | 任务只认领当前调用；权限切换关闭本任务执行 | 已报 root 并形成 test/browser-tools.test.ts 的真实 Runtime 反例 | 独立复跑对应正式回归通过 |
| 等待审批时 confirm→full，解除等待后浏览器白名单未激活 | 装配、发送前、调用门和执行模式一致 | 已报 root，真正 mock_gate 审批等待正式回归 | 独立复跑正式回归通过 |
| 点击 POST=1 后 CLI success，capture/save 抛错返回 browser_state_unavailable / effectUnknown=false | 发出后的无法核实结果记 unknown，不能按失败重发 | post-command-baseline.json 的 persist_after_success | post-command-current.json 返回 outcome_unknown/true，binding 保留 unknown |
| 点击 POST=1、wire outcome_unknown，unavailable.save 再抛错覆盖原 unknown | 跨层报告不得丢失实际未知效果 | post-command-baseline.json 的 persist_masks_unknown | 当前返回 outcome_unknown/true；实际 owner.json 写入失败同样通过 post-lock.json |
| loopback discovery 每 100ms 发空格，abort 与 close 在 3.6 秒后仍未完成 | 在途取消和后台停止有归属、可取消并能收尾 | discovery-cancel-baseline.json | 取消后 100ms 观察点 attach/close 均结束；无 cancel 的总期限 3006ms，见 discovery-total-current.json |
| close 起始状态 save 抛错直接 reject，未停止已登记 daemon | 后台停止应完成自有执行收尾，失败保留占用 | close-persist-baseline.json | 保存持续失败仍停止真实子进程，返回 false 而非 reject，见 close-persist-current-known.json |
| pending daemon 身份从 sidecar 核实后，save 抛错仍在 stopUnit 前退出 | 已核实自有进程应收尾；不声称停止、不释放未知占用 | close-persist-pending-baseline.json，ps=Ss | daemonPending 与 dashboardPending 均停止，ps=Z，无可执行残留；false/不可用状态保留 |
| A 暂停前已排队的 B 可用不同 taskId resume | 人工暂停后需拥有者新消息才能继续 | queued-resume.json：B 接受后 25ms 才释放 A 去 pause，B resume 成功 | queued-resume-current.json：B 被拒且 paused，随后真正新消息 C 成功并换代；使用事件接受 seq 而非时间戳 |

后续引用界面兼容补查：只把完整匹配 `e` 加数字的 bare ref 克隆规范为 `@eN`，保留原模型参数记录；仍要求规范形式、当前代次暴露集合及动作前新 snapshot 的 refs 集合三项核实。工具描述同时列出两种引用输入，未开放任意 selector、管理参数或旧代次。

Browser 工具 catch 的人工等待登记也已窄处理保存异常，保留原动作 unknown。cold 恢复、控制目录 sidecar、opaque fingerprint、跨进程 UUID 锁、附接不关用户 Chrome 的连接代码和真实三平台 acceptance 原始脚本/JSON 已读取；未再找到具体新增反例。

## 亲自执行

最终执行 `RUN_MODEL_CHECK=0 npx tsx --test test/browser-lifecycle.test.ts test/browser-tools.test.ts test/101-instance-lock.test.ts test/browser-model-acceptance.test.ts`：共 43 项，41 通过、2 真实模型用例跳过、0 失败；lifecycle 15、browser-tools 22、instance-lock 4。随后移除环境开关执行 `env -u RUN_MODEL_CHECK npx tsx --test test/browser-model-acceptance.test.ts`，仍为 2 项默认跳过，不启动真实模型。

引用兼容改动后另执行 `npx tsx --test test/browser-tools.test.ts`：22/22 通过；本目录 bare-ref.test.ts 4/4 通过，覆盖参数不变、拒绝 selector/额外宿主参数、当前 bare ref 正确发送 `click @e1` 一次，以及快照移除/代次变化均拒绝点击。reviewed-sha256.txt 已更新为该界面修复后的源码与测试。

本目录 current 脚本：post-command-current.test.ts（三项）、post-lock.test.ts（真实文件权限失败两项）、discovery-cancel-current.test.ts（一项）、discovery-total-current.test.ts（一项）、close-persist-current.test.ts（known/daemonPending/dashboardPending 三项）、queued-resume-current.test.ts（真实 Runtime/SDK/core，验证旧消息拒绝和新消息成功）均通过。命令均使用 `npx tsx --test <明确临时文件>`，没有运行真实模型。

POST 计数使用本机真实 HTTP server；CLI 仅替换 wire/程序启动边界，进程归属与 close 使用真实 detached Node 子进程和真实 PID/PGID/birth 记录。负例不能替代真实 Chrome 平台校准，也未这样声称。每份脚本 finally 只清理本轮创建的进程和控制目录；JSON 与脚本保留。

## 未覆盖与下一步

新增正式回归已直接读并对照原始 baseline：实际 HTTP POST 先触发存储失败，assert outcome_unknown/true、POST=1 和不可用绑定，能捕获已成功后误报及原 unknown 被覆盖；真实 detached 进程的 close 保存故障断言停止、false 与保留锁，能捕获提前退出；慢流 discovery 用独立总预算拒绝原空闲超时，取消断言 code；真实 Runtime/SDK 的 pause 断言旧排队调用未抵达恢复、新消息才恢复，IM 输入顺序沿原 inbound.registered；人工等待保存异常断言工具消息保留 outcome_unknown 和账本 unknown。

审查发现关闭回归等待 c.exited 没有预算，实施者已在正式用例加现有 5 秒 waitFor，再等待 exit；审查者随后复跑 lifecycle 15/15 通过，stdout 保留 final-lifecycle.stdout.txt。正式回归缺口已解除。

真实模型验收与拥有者人工体验结果归工单实施者记录，本审查未验证；不以 mock provider 的图像历史和 HTTP 提交代替。未运行完整全仓检查、未验证生产 tx 沙箱和系统依赖准备；这些不在本次独立实现审查的通过范围内。

本轮没有改 main，也没有提交、推送或部署。
