Status: needs-triage

# 容器部署下完全访问任务总是失败

## 问题

按部署文档运行的后台（`RUUKOTO_EXECUTION_BACKEND=container`，并配置了 `RUUKOTO_EXEC_*`）无法执行完全访问任务，提交时返回 `execution_unavailable`。

- [cli.ts](../../../src/cli.ts) `server` 启动时只传 `execution: { backend: execFlag }`，不带 `systemd` 配置（`src/cli.ts:184`）。
- `createLauncherFor` 在 container + full_access 且 `config.systemd` 缺失时直接抛错（`src/agent/execution/launchers.ts:339-347`）。读取 `RUUKOTO_EXEC_LAUNCH_SCRIPT`、`RUUKOTO_EXEC_UID` 等环境变量的 `defaultSystemdConfig()` 只在检查通过后才被调用（`launchers.ts:348-351, 362-367`）。
- 因此 `deploy/systemd/ruukoto-backend.service` 设置的执行账户环境变量不生效。

## 证据

- `test/10-access-modes.test.ts:364-383` 断言缺少 systemd 配置时明确失败，这正是 CLI 传入的配置形态；没有测试覆盖「已按部署文档配置执行账户」的情形。
- `launchers.ts:11` 注释：目标服务器的 systemd 路径未实测。[09：目标服务器部署](09-tx-deploy.md) 的端到端记录只包含 confirm 任务。

## 待定

- 由 CLI（或 `Runtime.start`）在存在执行账户环境变量时传入 `systemd` 配置，还是改为显式参数。
- 修复后在 `ssh tx` 目标机实测一次完全访问任务。

## Comments

### 2026-09-25：创建

在技能系统访谈（[22](22-skills.md)）中顺带发现。已核对代码与 service 单元，未在目标机复现。
