# 配置更新独立复核（catalog_credentials）

对象为 root 主工作区的配置写入与回执、格式迁移、remote、桌面设置，以及阶段 4 的模型、Skills、MCP、独立搜索和计划范围。直接读取 `.scratch/configuration-updates/spec.md` 和实际源码；本人编写的 IM 切片、catalog 与凭据切片不在独立审查范围内。下面指纹表示本轮实际读取版本；随后变动须复核受影响部分。

## 当前结论

本轮所审范围无未解决的工程阻断。实际启动入口曾在恢复 fileIssues 前解析坏 MCP 文件而全局退出；root 已增加只读 bootstrap，核实已有格式及完整版本链，在当前文件不符最后保存事实时仅用持久选择引导，随后按目标暂停。独立实际控制入口探针已验证：MCP 文件损坏后后台可启动，settings.read 报该目标问题，无关模型设置仍可经实际控制 socket 保存并生效。未知旧档案仍沿原封闭分支。

已提出并验证修复的意见如下。

- settings.read 需要独立的各 scope 生效事实；最近回执不等于当前选择。root 增加 effective 清单及显式分页。
- MCP 整文件删除服务时，旧服务的显式 effective scope 必须同步覆盖。独立 MemoryStorage 探针修前得到旧 version-0，修后得到新 version-1。
- 桌面必须读取 operations/effective 的后续页；否则第 33 笔后的未结操作丢失查询与撤回入口。root 加入独立 cursor、步长和档案身份核实，并补 34 条回归。
- remote 不能把自己没有接纳关联等同于后台操作不存在。CLI/本机已创建操作也可按原键查询。root 保留旧 v1 回执分支，并在无旧回执时核实档案后查询 v2 权威；独立跨入口查询探针通过。

## 亲自执行的验证

最终组合命令为 `npx tsx --test test/personal-settings-operations.test.ts test/desktop-personal-settings.test.ts test/personal-remote-maintenance.test.ts test/personal-mcp-publication.test.ts test/personal-model-updates.test.ts test/personal-mcp-updates.test.ts test/personal-search-updates.test.ts`，42/42 通过。覆盖空档案无根初始化、迁移中标记恢复、同键与修订冲突、意图/替换/保存/发布故障、共享 StorageFailed 关闭、A 等待时 B 独立发布和保存链恢复、撤回及迟到发布保护、缺文件的 direct Harness 恢复、两类分页、旧 maintenance、原 provider 的在途与冷恢复、连续 MCP label 保存链、独立搜索停用和旧计划。

MCP 删除 scope、remote 跨入口查询和冷启动实际控制入口三个独立探针 3/3 通过。还独立读审并亲跑 runtime_updates 编写的 QQ 候选证据 StorageFailed 关闭回归，1/1 通过：候选提交拒绝仍关闭原 Harness，client.stop 失败继续外传，仅后台关闭等待已报告候选提交结束，不恢复或使用候选，并释放已停止实例的锁。上述均为本机替身/本机真实 socket 验证，不证明真实模型、真实 TG/QQ、Linux 或两壳产品体验；这些验收由 root 持有。

## 文件指纹

- `apps/ruukoto/src/personal-settings-records.ts`: `237e849a21017e8b9add50b5fa97dbe831d6473eb94e4ede25b5287d65080f4d`
- `apps/ruukoto/src/personal-settings-operations.ts`: `06b918aa5a47a57514afcca45931b5f1b04fef4ffc134e8774ac6e3ace997a80`
- `apps/ruukoto/src/personal-settings.ts`: `91a46970042881417941540252f702ac6ed165392ca2e48cff4b966afde349d2`
- `apps/ruukoto/src/personal-profile.ts`: `fea3f6ebe16418528a22fa5fe3ab2de81ef34e22bc0b3769e0368c934e573d27`
- `apps/ruukoto/src/personal-control.ts`: `11762e6bc2ae016561ebe02f192c96812999122ff8997bd0e7b80c59ecd0a67c`
- `apps/ruukoto/src/personal-remote.ts`: `19f554be5195635ad7edda2f5979b025615d6bc75207415eaf9349761d95d154`
- `apps/ruukoto/src/personal-remote-maintenance.ts`: `ddda89bf424a49b0283b03167e42b7c2b925cb600785c1cf3ac95bee8f2fcdb0`
- `apps/desktop/src/main/personal-settings-controller.ts`: `8512a5a14bbf492306a6d002dad5994c44de11d3d900dd044a6debc23d90cfd7`
- `apps/desktop/src/renderer/personal-settings-state.ts`: `fe8c0d2481fe54a64b364449c35f9b8f395194410d2a95b18683b19e5673745b`
- `apps/desktop/src/renderer/personal-settings-pages.tsx`: `3af27a95c7e60ad1cb2af5608cb864466f4e01b1ca9ea4ee8e5d2704ee3c446e`
- `apps/ruukoto/src/personal-harness.ts`: `4b09ba97c93a6a3c0b2030a54837967ca7dac8c5ac07adced2e455186184d345`
- `apps/ruukoto/src/personal-model.ts`: `54021edf8e3c81e6f69ec43439a1d070e8f41075b7f7cbbabe01c20cd61baf68`
- `apps/ruukoto/src/personal-skills.ts`: `5153c0e1f89b6ec2c90d15c9ac8a6b51614d36c1011495c12f510e7c114a75cd`
- `apps/ruukoto/src/personal-mcp.ts`: `457d5bc75549e67347819444d5085c3305a472af2b588db4ccf8b2f2070b33f5`
- `apps/ruukoto/src/personal-tools.ts`: `75b680a51cfa24a9756ef66755406d231d75b99d857f33aa85d91721cf55c213`
- `apps/ruukoto/src/personal-schedule-scope.ts`: `15304ad9738b2a5da77b301374be7f42c93e02b7a18a23a74ddce0d948727015`
