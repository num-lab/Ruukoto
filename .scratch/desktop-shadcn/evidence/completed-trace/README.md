# 平铺工具与完成后收起验收

日期2026-10-18，macOS arm64、Node v24.15.0，基点4026a2e。对应[工单25](../../issues/25-flat-completed-trace.md)，验证可变 Demo 与 Desktop；没有启动真实模型或重启日常桌面应用、后台。日志仅规范行尾空白和末尾换行，保留构建警告。

## 工程检查

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| Desktop 工具、Read、Inspector、缓存、流和来源定向6文件 | 85／85通过，含无delta最终正文补读、不同任务隔离、分段、排队输入、未知时间与倒序100ms | [targeted.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fcompleted-trace%2Ftargeted.log) |
| lint、全workspace类型、notes、docs | 通过 | [static.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fcompleted-trace%2Fstatic.log) |
| Demo 类型、SSR与构建 | 通过，保留既有大chunk提示 | [demo.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fcompleted-trace%2Fdemo.log) |
| MyGo／Electron 构建 | 两者通过；Electron仍有既有图标、可选平台依赖和公证提示 | [MyGo](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fcompleted-trace%2Fmygo-build.log)、[Electron](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fcompleted-trace%2Felectron-build.log) |
| 两个 bundle 深度严格签名核验 | exit0 | [signatures.json](signatures.json) |

独立 trace_layout_plan_review 亲跑最终增量3条通过、重放两个完成竞态反例通过，无剩余阻断。此前18／32项审查组合与最终85项重叠，不相加。首轮旧缓存夹具缺少新接口、等待工具夹具复用失败缓存，均已修复并保留原错误优先级；没有降低断言让失败通过。完成竞态测试加入中间消息晚于thinking的时间顺序和加载前基线，保证能捕获原误认。

## 浏览器行为

[浏览器入口](browser-fixture.mts)以Vite虚拟模块加载[隔离夹具](browser-fixture.tsx)，实际使用 CodeState、EventFlow、Conversation 与正式CSS；记录和工具结果为确定性夹具，不冒充真实provider。通过UI按钮追加事件，没有向产品会话写入记录。

- [最终摘要与动画](final-summary-metrics.json)：同一radix-_r_0_容器，完成后closed，捕获demo-collapse的animationstart与animationend，Worked for 4s来自夹具任务实际起止时间，最终两段正文均在折叠区外；[正式组件截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fcompleted-trace%2Fdesktop-collapsed.png)。
- [正文延迟](late-final-metrics.json)：先完成但没有最终正文时open且无回复；正文到达后closed并播放相同容器的关闭动画。
- [滚动和窄浅色](browser-metrics.json)：历史思考正文高度134px、行高22.4px、内容3225px，overflow-y为auto；此前Thinking同样134px／1613px，键盘End／ArrowDown滚到1478px。手动重开捕获同容器demo-expand的开始／结束，最终分段仍在外。
- [完整Demo](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fcompleted-trace%2Fdemo-completed.png)：完成会话显示Worked for样例耗时、最终正文可见；默认待审批会话不提前收起，单条工具平铺，设置中工具调用状态不再显示Working标题。

原生应用实际任务、系统减弱动画开关和真实provider尚未重跑；CSS沿用既有prefers-reduced-motion规则。浏览器功能与两壳构建不替代原生主观体验。隔离fixture服务器验证后停止，Demo 5173保留供拥有者查看；未提交、未推送。源和证据指纹见[sha256.json](sha256.json)。
