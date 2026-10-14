# 内部回报输入展示实现审查

Status: resolved

## 对象与结论

2026-10-14，独立执行上下文 `/root/visibility_review` 直接读取[工单 09](issues/09-internal-report-visibility.md)、[规格 E5](experience-spec.md)、[计划第一节](experience-plan.md#一隐藏内部回报输入)、当前源码、调用方、文档与测试。检出基点为 `0307617057ae0586e7717863cfd44389f02394e3`，对象为其上的未提交实现；最终[输入哈希](experience-evidence/09-inputs.sha256)固定实现文件与规格/计划。作者自检只作导航，不替代独立审查。

独立实现复审通过，无未解决阻断。可信任务分类、历史首屏/分页/单条先到、真正用户同文/伪造请求键、连续分支、完整 JSONL 与模型请求、最终总结、↑ 历史、置顶及搜索诊断路径均已核对。协议为 23；等待工具与报告仲裁仍由 10 持有。这里的 resolved 只表示工程审查完成，拥有者实际体验仍待产品验收。

## 返工与回归证明

审查发现缺宿主标记的内部条目以普通正文降级后，后到 `task.output_entry` 会把它合并为内部 input 行，终态事件又将其删除，违反“保留普通展示”。现改为关联错误的条目保持独立 history 行，三类缺口均保留原文与诊断；新增最窄回归覆盖引用与终态后到。

较旧任务详情补输入时同步用途，无正文 queued 事件保留已知分类。单条补读只延后 `entry_not_found`，`history_corrupt` 明确可见。独立审查在临时隔离副本分别撤去历史过滤、任务过滤、较旧详情用途同步、关联错误独立保留，对应新回归均失败；最后一项为 actual Set(0)、expected Set(3)。临时副本已删除，没有修改根工作区。

## 独立亲验

```sh
npx tsx --test --test-name-pattern '内部回报|分页和单条读取保留|真实工作流回报|dev 最终汇总' test/11-history-read.test.ts test/13-tui-state.test.ts test/14-tui-app.test.ts test/115-workflow-final-delivery.test.ts
npx tsx --test --test-name-pattern '协议不兼容|协议版本不兼容' test/12-reconnect-pending.test.ts
npx tsx --test --test-name-pattern '关联有缺口|内部回报|真实工作流回报|历史单条补读只延后' test/13-tui-state.test.ts test/14-tui-app.test.ts test/66-control-seam.test.ts
git diff --check
```

分别为 4/4、2/2、最终返工后 4/4 通过，差异检查通过；以上由独立审查者亲验。作者完整相关回归及静态门禁见工单与日志，不把它们改记为审查者执行。

## 未覆盖与交接

未执行全量检查、Linux、真实模型或真实 IM。离线验收使用真实 Runtime、Driver、控制协议与 SQLite，模型/IM 为本地替身；不能据此宣称真实服务和拥有者体验通过。下一责任人为拥有者核实实际对话体验；联合真实环境证据由 11 持有。协议 23 要求后台和客户端同步升级。
