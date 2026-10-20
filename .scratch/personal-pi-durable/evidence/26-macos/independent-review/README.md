# 独立实现审查与撤修复反证

根工作区只读。副本只复制个人宿主、错误类型、对应测试、worker 与 package.json；node_modules 链接生产依赖，共享执行源码未改，frozen-manifest.json 固定实际生产源码哈希。

同一窄用例在冻结副本基线通过；只撤去 runPersonalCommand 的 full_access 模式白名单后，以 command_record_invalid 失败；恢复相同字节后通过。命令、退出码见 commands.json；输出见 baseline.log、withdrawn.log、restored.log；源码及唯一差异见 personal-command-execution.frozen.ts、personal-command-execution.withdrawn.ts、withdrawn.patch。restored-production-comparison.json 证明副本已恢复且共享生产文件与冻结哈希一致。

abort-check.mjs 直接调用最终生产 section renderer，令 committed snapshot 抛出原错误且 Context 已取消，断言抛回同一错误，未被保守权限文本吞掉。abort-check.log 为亲跑输出。

full-access-scope-review-tests.log 是四文件 72/72 流程回归；开始于新增权限 section 之前，故其模型 systemPrompt 数字不是最终文本值。full-access-scope-review-permission-final.log 是最终三模式提示及关闭重开后 full→confirm 复用 3/3；full-access-scope-review-host-final.log 是修正 bwrap 探测 mock 后最终 full 宿主 2/2。最终模型快照估算为子 systemPrompt 42、toolSchemas 268。

full-access-scope-review-fallback-final.log 为最终无 tracking 准入拒绝与 section 缺工作/读失败/root 跳过的 2/2；abort-check.log 另证明 Context 取消时原错误保持传播。

真实 Linux、旧冻结程序打开新档案、模型/IM 与产品体验由总工单其他证据持有，本目录不将它们计为已执行。
