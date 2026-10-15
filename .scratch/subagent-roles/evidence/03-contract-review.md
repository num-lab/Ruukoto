# 03 当前工作区快照：非作者独立审查

本审查由 contract_audit 在独立副本执行，只读主工作区。判定依据为工单 03 的 R5、R9–R11、R14 与仓库错误、持久化和来源保护约定。审查对象是最终原始捕获、split-index 与 staged blob 闭合性、模板与 promisor 隔离、对象纯文件预检、完整受影响字节的核对以及 `core.symlinks=false` 修复。未发现尚未解除的阻断。

明确排除本审查者编写的普通宿主绑定、运行时 snapshot 门禁、大小写与文件/目录路径修复；这些需要其他审查者独立验收。本报告中的 author 路径撤修证据仅证明用例辨别力，不是对该路径实现的独立验收。file bind 的原生平台证据由 native_probe 独立负责。

| 文件 | 最终 SHA-256 | 主仓/副本一致 |
| --- | --- | --- |
| `packages/runtime/src/work-copy.ts` | `1cbea7a68aacb53ae32bc3692f55301293f02a2be9031b2b63751fe8f1805780` | 是 |
| `packages/runtime/src/workspace-snapshot-script.ts` | `fc2c1c8e01ee35cb01a47d2725665b953d856505d9c81e62461122e5a7fb9fb7` | 是 |
| `packages/core/src/workspace-snapshot.ts` | `90f309d196ef71161790eb96ec49b61c0711f9d6fea1514b5b3ae1dfff3e6d0e` | 是 |

| 原阻断 | 原机制证据 | 最终同机制复核 | 结论 |
| --- | --- | --- | --- |
| 仅源索引引用的 staged blob 删除仍通过恢复/冻结 | `snapshot-review-staged-object.log`：原索引引用已删除对象，preflight/freeze 均 accepted | `snapshot-review-staged-object-final.log`：同夹具两处均 snapshot_corrupt | 原索引、阶段条目、实际共享索引受同一摘要认证，blob 闭包覆盖阶段对象；阻断解除 |
| partial clone 捕获向来源自动下载 promisor blob | `snapshot-review-promisor.log`：捕获 accepted，来源新增 4 个 pack 配套文件 | `snapshot-review-promisor-final.log`：明确 rejected/snapshot_failed，来源新增对象文件为空 | 来源对象只读私有 Git 视图不加载来源 remotes/config，缺对象不下载；阻断解除 |
| 用户模板 alternates 使私有 hash-object 刷新源 loose object 时间 | `snapshot-review-template.log`：alternates copied，2000 年 mtime 被刷新 | `snapshot-review-template-final.log`：未复制 alternates，原 mtime 946684800000 不变 | 空模板、固定 SHA-1 及写对象前 inspect 保证私有对象独立；阻断解除 |
| core.symlinks=false 把新/改指向 symlink 汇入为普通文本文件 | `snapshot-review-git-config.log`：两种 symlink applied 但 isSymlink=false | `snapshot-review-git-config-final.log`：两种 symlink applied 且 isSymlink=true；执行位增/减也正确 | 验证与来源 apply 固定 core.symlinks=true，原配置与索引保持；阻断解除 |

纯文件预检复核了对象 sha1、zlib header/body 长度、blob/tree 类型、树闭包与安全 UTF-8 路径，以及私有 loose 对象无 alternates、commondir、symlink 或多硬链接。指纹保存来源/共享 Git/私有库身份、HEAD 与复合 indexDigest，损坏不从 HEAD 补造。捕获原始字节并稳定双读，独立验证与汇入都相对保存树；后来的同文件不同 hunk 改动仍先冲突、零套用，无关文件不被重写，原 staged/unstaged 历史不计子增量。

最终非作者定向自动组 `snapshot-final-nonauthor-core-tests.log`：12/12 通过，覆盖原始当前内容/来源零写入、同文件不同 hunk 拒绝、四种私有对象别名、Git 指向切换、split-index、阶段对象、promisor、模板与 symlink 验证/汇入/重复 already。四个最终机制脚本分别独立执行，全部与预期相符；测试范围不包含本审查者的路径或 runtime 实现。

作者路径补丁的验证另存 `snapshot-path-kind-tests.log`（22/22）、`snapshot-path-kind-regression-synced.log`（同步主仓既有修正并 build 后 55/55）、`snapshot-path-kind-typecheck.log` 与 `snapshot-path-kind-lint.log`（均退出 0）。撤去仅路径脚本修复，`snapshot-path-kind-withdrawal.log` 的 7 条目标用例全部失败；脚本已 finally 恢复，主仓未改。case-only 子改名在 APFS 因既有 Git apply EEXIST 明确 conflict、保留两边与原错误；区分大小写的文件系统要求 applied→already，无手工源回写协议。

最终文档只读复核已关闭原有阻断：`docs/modules/execution.md` 的创建图及 6 项步骤与最终 capture → 独立宿主 Task → create `--no-checkout` → 原始树物化一致，HEAD 仅溯源及对象可用性预检；Git target 表含 snapshot 与目录身份，捕获/登记权限、私有索引/模板/promisor 与未核实停止的保留规则均已对齐。文件 bind 的全部普通文件 dev/ino 检查、显式来源保护范围及宿主入口已写明；未显式挂载的全局保护根中外部特权预存 bind 这一既有缺口有明确边界，未宣称全局物理隔离。按主仓当前字节复制到独立副本，最终文档 SHA-256 为 `08779f38633341a34f3d6b3812a842fc33805293137d0771cf5cadb99c1aa9f7`。
