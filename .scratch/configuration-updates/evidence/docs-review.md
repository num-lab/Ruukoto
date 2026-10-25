# 配置更新文档一致性复核

本轮直接核对 README、usage、personal-durable、desktop、runtime、execution 及本轮新增五篇 implemented notes，对照当前 root 的设置、remote、请求选择、IM 和执行迁移实现；未重跑已通过测试。

结论：所审范围无剩余事实错误或文档阻断。普通保存停存启、Skills 固定请求被当前清单否定、连续 MCP 显示名使计划失效、旧恢复以当前文件否定历史等残留已修正。机器协议已记录独立 operations/effective 每页32项和各自偏移，scope 生效选择与文件修订分别说明，fileIssues 及实际控制入口 cold bootstrap 的证明边界一致。普通 HTTP MCP 未知不阻止保存/发布，仍保留原版本、原请求及同来源/端点占用。命令与服务 host 基线、历史 entry/operation 边界和只读宿主不启用写操作的说明与最终 delta 一致。

末次增量复核：后继服务文件版本继承同值 hostService 元数据，文件正文仍只有三条部署路径；撤回写成文件后从持久基线取得 useSudo/超时，脱离原宿主注入仍可冷启。该说明与最终 records、settings-operations 和 Harness 的取值路径一致。已读 v2 unknown 与 fileIssues 只影响所属目标的 disabled/writable 资格，不再把它们提升为设置容器全局导航等待，符合文档按对象隔离的说明；旧 v1 pending 的原保护保留。MCP CLI 的启停/移除只展示真实设置回执，不再无条件追加已生效结论。本次只读核对这些增量，未重跑广泛测试。

13 篇旧 notes 只更新顶部的有效规则提示，旧决定正文保留，最终已与对应新笔记形成双向相对链接。独立副本 verify-notes 217 篇通过；主区最终文档检查由 root 汇总。

未发现把本机替身或工程自检写成 MyGo、真实 IM、真实模型或 Linux 产品验收通过的表述。各已执行的真实环境证据与待验项仍归工单，不以 implemented 状态替代产品验收。

## 已读文件指纹

- `README.md`: `f924c700f5dc2281b95372c2b5b32a798417dfc1b0498e00061f3ffc2e251b4c`
- `docs/modules/personal-durable.md`: `aaab6f4701b148272bb0af6394726873bc032f7e3d25fd2866bd24e0ebd7706c`
- `docs/modules/desktop.md`: `621cfc090d2890e0b37d5761b30585812da34af608c95bd9015a9929e17fc478`
- `docs/modules/runtime.md`: `9db80a50c3f14d41cf8ab2b293c8326078a93330cd0e5b77136017934790f875`
- `docs/modules/execution.md`: `fc3f1913b2be870e01d528feb1a627b0ca06a7bec987e912a54f51a6b9aa7405`
- `docs/usage.md`: `a9275e72d3b9254f272a4d1182973bf89d9a14d910e4298cdcc11d10346e17ac`
- `.agents/notes/implemented/architecture/2026-10-25-personal-settings-versions.md`: `1e4aec6506b7ddb02beb5aafa9207cdab42225d1d39d15e5d9008e410b75e278`
- `.agents/notes/implemented/architecture/2026-10-25-personal-request-configuration.md`: `1ec16f114866cbcdb73dab1db5363313caae61a86d2faab44bf8827c4bc2a068`
- `.agents/notes/implemented/architecture/2026-10-25-personal-execution-configuration-versions.md`: `92db5aabbb662214cd5f4ef411331a56ece558b3892cbcc3478b99c599b88f20`
- `.agents/notes/implemented/architecture/2026-10-25-personal-im-updates.md`: `00c9a14355b47e6bb763541b48da1f7a69df7361c330381ab3659c27a91e9922`
- `.agents/notes/implemented/simplification/2026-10-25-configuration-checks.md`: `257686c0e2ffb97d851c7e245d48702e38a4eedc77a6115fedc05c2f2548c102`

## 本轮增量源码指纹

- `apps/ruukoto/src/personal-settings-records.ts`: `f559d4a47f39d809218dfdd6d642520f160d903f74b9710163144216eb06e72f`
- `apps/ruukoto/src/personal-settings-operations.ts`: `88db997d74b2b12644ba397ef520d67feaba16cdee95356ce9bb2999a5993d20`
- `apps/ruukoto/src/personal-harness.ts`: `0895997becb3f4f015ca7f36dafde37eb58cd7bbe1158fac18df034b111a9dde`
- `apps/desktop/src/renderer/personal-settings-state.ts`: `7cb8142342534e8ad7a0d487f43da999834194745963805d0a23c90ce6e59fc0`
- `apps/ruukoto/src/personal-mcp-cli.ts`: `bd2548e04dfdb2e1145699cf23b2c3fd0695d34d6c326e262ca5019e1dbbdbf6`
