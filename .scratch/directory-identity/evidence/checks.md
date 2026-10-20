# 设备号校验调整的验证

2026-10-18，macOS arm64、Node 24.15.0；被检文件对应 [SHA-256 清单](sources.sha256)。范围不含此前未提交的桌面 GUI 调整。

## 回归有效性

在生产代码修改前执行 `npx tsx --test test/dir-identity.test.ts`：6 项中 2 通过、4 失败。两个仅设备号变化的共享校验、工作区读取及普通任务启动均因旧设备号失败；路径/inode/类型/存在性反例通过。修改后该文件 6/6 通过，随后补入等待后重取占用断言并随定向集合再次通过。

## 工程检查

- `npm run check:static`：退出 0，lint、全部 workspace typecheck、notes 与文档门禁通过。
- `npx tsx --test test/dir-identity.test.ts test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts test/07-real-tools.test.ts test/08-approvals.test.ts test/10-access-modes.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts test/101-native-execution.test.ts test/125-agent-wait-resource.test.ts test/desktop-workspace-files.test.ts test/desktop-workspace-git.test.ts`：退出 0，131/131 通过，零跳过，58.50 秒。
- `git diff --check`：退出 0。

模型使用离线 mock，Read 通过真实本地 worker 读取临时文件；同时直接断言 LaunchSpec 与占用使用当前设备号、历史登记值不改写。原生执行策略的身份拒绝沿用 101 用例，不将该集合记作重新挂载或真实平台沙箱完整验收。未操作实际磁盘挂载，未重启日常后台，未运行全仓 `npm run check`。

## 独立审查

device_identity_plan_review 直接读取实际代码、测试、文档与内容清单，于 2026-10-18 给出无阻断结论。审查者独立运行新增回归 6/6 通过，并向 `prepareNativeLaunch` 传入只有 dev 错误、ino 正确的启动身份，亲验仍返回 `execution_unavailable / sandbox_rejected`。作者随后核对 SHA-256 清单均匹配，审查后未修改被检源码、测试或模块文档。
