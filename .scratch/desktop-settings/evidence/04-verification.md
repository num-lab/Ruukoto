# Skills 托管后端实现与验收

日期：2026-10-21。基点 `18866321487639b55cea22f3b802b1eadcdaaf35`；本记录对应本单实施差异，拥有者已明确要求提交当前分支。测试使用临时隔离目录及 mock provider，没有操作日常技能库或生产档案。

## 实际交付

共享 `managed-skills.ts` 提供稳定身份列表、正文、导入预览/提交、启停、逻辑移除和内部布局检查。外部扫描与符号链接读取保留，托管不覆盖外部重名赢家；`loadSkillLibrary(string)` 仍读外部库，`loadHostSkillLibrary(hostDir, externalSkillsDirs)` 明确分开托管根与外部 skills 子目录。新宿主元数据随快照保存，原目录文字与正文版本哈希规则不变。

固定包路径为 `managed-skills/packages/<UUID>/<原包名>`；格式版本 1 的清单保存身份、完整内容修订及 enabled/disabled/removed，原子清单提交才可见。复制拒绝链接、硬链接、特殊对象和越界，预览与发布核对同一内容。每包限 512 文件、8 MiB、128 子目录和 32 层；目录 0700、文件 0600、当前所有者且文件 nlink=1。合法孤立包、部分临时清单和安全暂存可重开但不可见、不自动删除，实际残留满集合时先拒绝新导入。

新 Code 任务从 ended wait 参考启动时按当前托管状态过滤并保存本次选择及 prompt；本任务恢复/重取资源不重扫技能。停用/移除不移动原路径，旧正文、引用、wait、选择记录、历史与 prompt 哈希不变，新自动目录及显式调用不再选入。资源启动前校验失败由 Driver 正常失败收尾，保留 code，零模型/工具操作且无虚假占用。

Runtime/control 增加 `skills_list`、`skill_get`、`skill_import_preview`、`skill_import`、`skill_set_enabled`、`skill_remove`，旧 `list_skills` 保持 TUI 返回兼容。管理列表按 1–100 条分页，诊断上限及截断事实可见，详情仅按身份返回有界正文。提交回执直接来自已校验内容与已提交清单，提交后读取故障不冒充未保存。

## 工程验证

环境：macOS / Darwin，Node v24.15.0，离线 mock。根检出最初缺少既有脚本 worker，执行 `npm run build:script` 后恢复测试前提；没有改变工作流接口或构建脚本。

| 检查 | 实际结果 |
| --- | --- |
| `npm run build:script` | 通过 |
| `npx tsx --test test/56-skills.test.ts test/personal-skills.test.ts test/125-agent-wait-model.test.ts test/managed-skills.test.ts test/66-control-seam.test.ts test/125-agent-wait-resource.test.ts test/managed-skills-reference.test.ts` | 该轮 73 条，71 通过、0 失败、2 真实模型按开关跳过；执行时托管文件为 17 条，新增加的共享祖先重读用例由下一行及独立 18 条重跑覆盖 |
| `npx tsx --test --test-name-pattern='源父路径' test/managed-skills.test.ts` | 2/2，覆盖链接竞态拒绝、无关子项完整重读和持续三次变化拒绝 |
| `npm run check:static` | 最终源码与 18 条托管用例通过 lint、全 workspace 类型、笔记及文档门禁 |
| `git diff --check`、`npm run change-scope -- --base 18866321487639b55cea22f3b802b1eadcdaaf35` | 通过；范围为技能、Driver/Core 参考字段、Runtime/control、定向测试及对应文档/任务记录 |

托管回归覆盖引用复制及源不变、外部只读赢家、symlink/硬链接/FIFO/设备拒绝、总量/数量/深度、根正文解析、预览后变化、修订冲突、复制期间变化、清单失败孤立包、部分临时内容、未知节点/版本及权限、仅显式与停用区别、稳定身份移除、诊断上限、残留容量、祖先链接竞态、提交后读取失败和有界重读。设备负例用受控 stat 夹具，其余文件复制、FIFO、链接、权限与清单故障用真实临时文件系统。

## 独立实现审查

独立上下文 `/root/reference_paths` 直接读取工单、R7、完整实际差异、调用方和文档，亲跑当前 `test/managed-skills.test.ts` 18/18、`test/managed-skills-reference.test.ts` 3/3、技能管理控制面 2/2 及差异检查，与作者全套并行负载下也通过。最终无未解决实现阻断，完整静态门禁由实施者执行。

初轮的源祖先换链接、256 个安全残留后新增身份破坏重开、校验早退虚假占用已修复并独立复现复核。引用回归发现 macOS 系统祖先别名与 realpath 比较不同，已按已验证固定包的 realpath 修正。并行检查发现共享临时祖先无关子项变化会造成 ctime 误拒绝，采用最多三次完整安全重读，每次丢弃不稳定内容，所有路径/文件检查及最终预览哈希比较保留。首次引用失败因缺构建制品，补建后通过，不记为工作流接口缺陷。

`/root/control_paths` 在独立副本实现控制面接线与引用回归，临时撤去新任务过滤或恢复时重扫都会使 disabled 用例失败，变异已恢复。真实 Runtime 的原任务 → ended wait → 同轮重取资源 → 新内部对话/显式拒绝 → 重启及旧证据哈希恒定均由新增引用用例证明。

## 验收与下一责任人

本单工程验收通过，产品主观验收不适用：只交付后端与选择规则，GUI 产品验收明确由 05/08 持有。因此本单 resolved，05 可消费 Code 控制面；06 可消费共享托管 API 与 `validateManagedSkillsLayout`，必须在 Personal 档案锁、顶层布局/权限分类及未决检查后调用。当前未接入 Personal 档案，不把共享模拟根记为 Personal 设置已交付。

未跑全量 `npm run check`、真实模型、Linux 或 GUI，未推送或部署。逻辑移除保留包字节，失败残留不自动回收，集合满时拒绝新导入；双外壳、真实 SSH 与 Personal 停存启继续由后续工单验收。

## 提交授权

2026-10-21，拥有者明确要求「提交」，据此提交当前分支，不推送。实现未变，沿用上述定向测试与独立审查证据，提交钩子执行静态门禁。
