# 03工程验证

2026-10-23，在057e3366上实施，双端独立工作副本汇总到主工作区；验证时变更尚未提交。Mac主工作区Node24.15.0，另以Node22.19.0验证stdio；Linux原语环境与指纹见[独立证据](03-personal-linux/README.md)。下列通过均为实际执行结果，不代表真实Cua桌面、模型或人工体验验收。

## 主工作区

| 检查 | 结果 |
| --- | --- |
| `npm run check:static` | 最后恢复发送复核增量前，lint、根及全部workspace/foundation类型、笔记和文档检查通过；该增量另验如下 |
| `npx tsx --test test/cua-mcp.test.ts test/mcp-transport.test.ts` | 39/39，0skip |
| `npx --yes --package=node@22.19.0 node --import tsx --test test/cua-mcp.test.ts` | 10/10，0skip；初始化、关闭、写前/写后取消、退出、证据与消息限额 |
| `npx tsx --test test/personal-cua.test.ts test/personal-mcp.test.ts test/personal-mcp-recovery.test.ts test/personal-mcp-controls.test.ts test/personal-mcp-config.test.ts test/personal-settings-blockers.test.ts test/personal-settings.test.ts test/desktop-personal-settings-pages.test.ts` | 120/120，0skip |
| `npx tsx --test --test-concurrency=2 test/24-mcp.test.ts test/25-mcp-write.test.ts test/63-approval-gate.test.ts test/66-control-seam.test.ts test/desktop-settings-mcp.test.ts test/desktop-settings-mcp-backend.test.ts test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts` | 128/128，0skip |
| `node --import tsx --test --test-concurrency=1 --test-timeout=120000 test/cua-code.test.ts test/native-macos-identity.test.ts test/101-native-macos-helper.test.ts test/100-worker-stop.test.ts test/64-tool-op-ledger.test.ts` | 73/73，0skip；唯一原生测试执行者，Code实际装配与原生监督器使用离线MCP夹具 |
| `node --import tsx --test --test-concurrency=1 --test-timeout=120000 test/cua-code.test.ts` | 最后恢复发送复核增量后3/3，0skip；准备后撤销零发送，重新启用可新观察 |
| `npx eslint packages/agent/src/mcp/code.ts test/cua-code.test.ts test/personal-cua.test.ts && npx tsc --noEmit --pretty false` | 最后增量通过ESLint与根类型检查 |
| `npx tsx --test --test-concurrency=2 test/personal-work.test.ts test/personal-reports.test.ts test/personal-scheduler-integration.test.ts` | 76/76，0skip |
| `npx tsx --test --test-name-pattern='durable 文件检索' test/personal-tools.test.ts` | 1/1，0skip |
| `npm run build:native` | 当前原生监督器构建通过 |
| `npm run desktop:build`、`npm run desktop:mygo:build` | 两个darwin/arm64桌面壳构建通过 |
| `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Ruukoto.app`及同命令检查`dist/mygo/darwin-arm64/Ruukoto MyGo.app` | 均valid on disk并满足Designated Requirement；本地ad-hoc签名，不是发布或公证 |
| `git diff --check` | 通过 |

## 模型输入与反例

Code实际模拟provider请求证明受限schema、定义和图片进入模型请求，原schema与真实参数留原操作；selection record估算toolSchemas为10940→11652，systemPrompt为1503→1503。Personal以本版本普通HTTP配置对照Cua配置，对实际请求的静态tools/system字符数除4向上取整，toolSchemas为5304→5304，systemPrompt为119→119；这不含动态工具结果、消息历史或图片，也不代表相对旧代码基点的总开销。远端受限定义通过mcp_tools结果进入历史。最后增加该估算后，首条Personal持续连接用例再次通过，未改产品实现。

反例守住：目标/来源/文件输出参数拒绝，视觉能力不符零发送，旧批准失效，原请求或批准消费落盘失败零发送，慢请求/进展记录跨SDK取消或超时后不能晚发，实际写后丢答和超限只发送一次，子进程退出丢弃观察，冷启动与换配置不能跳过冻结，完整原错误已知、不完整应答继续未知。两端新观察均须保存成功，接受绑定具体观察；成功观察后重观察失败不能接受旧图。Code在保存恢复请求的同一Store事务内复核启用状态、本次观察修订与固定配置，准备后撤销不能发出截图；新观察使用当前修订，原未知动作修订不变。Personal停止/开始/观察/接受事实独立于remoteEnded，统一结束来源/工作/报告/设置等待；普通HTTP的人工说明仍不能解锁，原双向HTTP目标互锁保留。

## 独立审查与原失败

独立上下文/root/shared_review直接核对规格、实际代码、固定CLI/Driver schema、SDK发送/取消/超限行为与全部消费者，最终共享层及双端工程审查通过，无未解决阻断。审查者亲自运行共享10项、Personal120项和早期Code相关41项；Code最后启动、旧图及恢复发送前复核修复均重新读审，主工作区73项串行原生结果及最后3项回归如上。

独立副本拓展测试曾在文件检索首个list_files结果解析处失败，主工作区相同窄用例通过，未因此修改文件检索。原生夹具曾有跨命令并行轮挂起，已停止仅该轮测试且不记通过，最终唯一执行者串行73项全部通过。文档预算最初超限，移除术语表重复的钉版时序细节、由模块文档持有后通过，未提高预算。Linux原语验证的namespace权限和Docker超时原失败保留在上述独立证据中。

未运行真实Cua、正式桌面/模型或拥有者恢复体验，未操作旧实验容器。04仍须完成程序/沙箱选择、安装权限检查及实际截图查看，05完成正式双端流程与一次丢答恢复；当前引用与CLI路径不算人工已看过截图。未运行全量npm run check，未推送、部署或发布。
