# 控制面路径按显式产品解析，后台可由外部 node 拉起

Status: plan-review

## 目标与边界

实现[规格 R7](../spec.md)中控制面一侧的前提：一个进程能同时解析两个产品的路径，`ensureBackend` 能用调用方给的 node 与 bin 拉起后台。TUI 与 CLI 行为不变。

## 方案

1. `packages/control/src/connect.ts` 的 `defaultDataDir`、`defaultAgentDir`、`controlDirFor` 增加可选的产品参数；未传时仍用 `productFromEnv()`，现有调用方不改。
2. `ensureBackend` 已支持注入 `spawnArgv` 与 `env`；补一条用例证明以外部 node 路径加固定 bin 拉起时，门控、实例锁收敛与日志尾部报错行为不变。如果注入的 node 不存在，返回可读错误，不抛未分类异常。
3. 文档：`docs/modules/control.md` 对外接口补充显式产品参数。

## 进展与交接

- 当前：方案已经拥有者确认，待独立方案审查；实现未开始。
- 下一步：方案审查者核对 `productFromEnv()` 的其他调用方是否也需要显式参数。
- 基点：`develop` @ `4611eff`。可与 01 并行。
- 阻塞：无。

## 验收与证据

工程待验证。新增用例：同一进程内分别以两个产品解析出不同的数据、控制目录与 socket；`test/72-on-demand-backend.test.ts` 增加外部 node 加 bin 的拉起用例与 node 不存在的错误用例；`test/06-connectivity.test.ts` 与 `test/29-cli-entry.test.ts` 不回归。产品验收不适用。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。
