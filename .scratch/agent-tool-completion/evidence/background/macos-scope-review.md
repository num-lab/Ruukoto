# macOS 后台范围专项审查与启动竞态修复

对象：最终主工作区 C 监督器、持久身份测试，以及 100-worker-stop / 101-native-macos-helper 回归。

结论：无未解决阻断。历史受管 PGID、SID 和已知成员 PID 只增加保守拒绝；信号路径仍要求完整生命周期身份。每次 sample 对已知成员累计当前范围，受限模式继续使用原全 UID 未知孤儿规则。

独立审查发现启动期 setsid 竞态会永久纳入宿主组/会话；增量补丁仅在根进程尚未建立自身 PGID/SID 时跳过范围累计。C 根命令只能在 setsid 后通过启动门，因此省略启动前宿主范围不丢业务后代。补丁由父实施者独立审阅后导入。

## 实际检查

- 严格 clang（-std=c11 -Wall -Wextra -Werror）通过。
- test/native-macos-identity.test.ts 定向 ESLint 通过。
- 新增 proc API 桩测试覆盖 setsid 前、跨 setsid 快照、正常建立范围；固定版通过，隔离副本撤去修复后在 unrelated orphan 的 !new_orphan 断言失败。
- 最终主工作区：npx tsx --test --test-concurrency=1 test/native-macos-identity.test.ts test/101-native-macos-helper.test.ts test/100-worker-stop.test.ts；60/60，通过，无跳过，37.37 秒。
- 最大转义命令分页反例独立重跑：20 条记录分10页，≤256 KiB/页，无重复或遗漏。

## 被检内容 SHA-256

- `packages/agent/src/execution/native-macos-supervisor.c`：`1f27e9ad7f639621cf1ab048782639749408aa071c24187d9be51cadf2cbb82d`
- `test/native-macos-identity.test.ts`：`661e25408b13c81c901e48d3f352de822548445dd029704a169bc590f9ece5fe`
- `worker/native-macos-supervisor`：`5a75956c76faaec1855b215c5c48e0de519fc9d6cc897fb7b30319af0a3aef9b`

未由本专项重新验证真实模型、真实 browser、Electron/TUI 完整交互。完全访问主动脱离且未曾归属的分支与外部服务仍属已确认例外；不是所有同 UID 进程的全局回收证明。
