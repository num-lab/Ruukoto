# 工单 28 Linux 定向验证

2026-10-17 经 `ssh tx` 在新建临时副本 `/tmp/ruukoto-mcp28-linux.eI5S8D/source` 验证。系统为 Linux x86_64、Node v24.21.0、npm 11.19.0、Python 3.12.3，使用非 root 用户。没有修改生产或既有检出；本次远端临时目录已删除，见 [cleanup.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F28-linux%2Fcleanup.log)。

源码快照包含当前工作区的 572 个源码、测试、脚本及配置文件，归档 SHA-256 为 `b5aaa06d55e4396c2ac283e502527dc4b8d95299bcc5dd56d16eb96154fa298c`。逐文件摘要见 [source-tree.sha256](source-tree.sha256)，基点和采集时间见 [source.json](source.json)。远端解包后和测试结束后都逐文件校验通过；测试结束时主工作区对应文件与本次快照无差异，见 [source-recheck.json](source-recheck.json)。

## 结果

| 命令（在临时副本执行） | 结果 | 原始日志 |
| --- | --- | --- |
| `RUN_MODEL_CHECK=0 node --import tsx --test test/personal-mcp-config.test.ts test/personal-mcp.test.ts test/personal-mcp-controls.test.ts test/personal-mcp-recovery.test.ts` | 40 条通过，0 失败，0 跳过 | [mcp-tests.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F28-linux%2Fmcp-tests.log) |
| `RUN_MODEL_CHECK=0 node --import tsx --test --test-name-pattern="服务核实 HTTP：Linux sudo 接线、原状态刷新及慢停止不阻塞独立聊天" test/personal-cli.test.ts` | 1 条通过，0 失败，0 跳过 | [linux-service-http.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F28-linux%2Flinux-service-http.log) |

覆盖真实回环 HTTP、原 MCP 请求与响应、审批、凭据失效、未知效果、取消、原生工具恢复、响应提交前 SIGKILL、原入口控制、委托与报告暂停。Linux 服务用例执行 helper/sudo 命令桩，未操作生产服务；真实模型、真实远端 MCP 和真实 IM 仍属外部验收。

## 环境准备限制

`npm run setup -- --skip-hooks` 因远端磁盘不足而失败；清理本次安装残留后，省略开发依赖的第二次 setup 仍因 `ENOSPC` 失败。两次原始输出分别见 [setup.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F28-linux%2Fsetup.log) 和 [setup-production-deps.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F28-linux%2Fsetup-production-deps.log)，npm 诊断保存在 `npm-debug/`；其中一份因磁盘耗尽而截断的原始日志以 gzip 原样保存，未补写或删除原字节。旧依赖树不含当前 pi durable 且锁文件不同，因此没有复用或修改它们。

测试使用本次安装已解出的运行依赖，`tsx` 和个人 harness 导入探针成功后直接通过 Node 运行，未替换源码或注入模块替身；没有声称完整 setup 成功。实际根依赖解析记录见 [runtime-deps-probe.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F28-linux%2Fruntime-deps-probe.log) 与 [final-source-and-dependencies.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F28-linux%2Ffinal-source-and-dependencies.log)，两代 Pi 依赖按锁文件并存。环境与归档核验原始记录见 [environment-and-source.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F28-linux%2Fenvironment-and-source.log)。

本证据证明上述定向用例在该 Linux 副本通过，不证明 Linux 全量安装、构建或全仓检查通过；完整环境准备仍需更多可用磁盘空间。macOS 构建和静态检查由工单中的其他证据承接。

## 汇总后增量

上述快照验证后，本机新增了「未装配 MCP 时 /MCP 只返回配置指引且不生成菜单」的守卫与重开回归，仅影响 `personal-mcp-controls.ts` 及其测试；最新 macOS 控制/TG 72/72 与独立增量审查由[本机材料](../28-macos/README.md)持有。Linux 40/40 对应本页原快照，没有将未在 Linux 执行的新用例记入本页数量；其余后续变更为文档、交接记录及 schema 文件末尾换行规范化。
