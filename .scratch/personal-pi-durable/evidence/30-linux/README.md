# 30 独立 Linux 证据

对应[工单 30](../../issues/30-browser-media.md)。独立审查者通过 `ssh tx` 在 Ubuntu x64、Node 24.21.0、uid 1003 的专属目录执行，没有读取个人生产档案；原始环境在 `records/environment.json`，命令及退出码在 `records/leaf-tests-result.json`。

## 定向用例

`node --test built/personal-media.test.mjs built/personal-browser.test.mjs built/browser-lifecycle.test.mjs built/personal-browser-integration.test.mjs` 为 56/56、零跳过，见 `records/leaf-tests.log`。覆盖媒体 14、个人浏览器 12、组合 13、共享生命周期 17；浏览器命令使用测试替身，不等于 Linux Chrome 真运行。

本次没有远端 npm install/setup/build；从本机依赖闭包准备 119 个已核实的包，复制 66 个仓库源文件，并通过 esbuild 生成 5 个 bundle，过程由 `build.mjs`、`runtime-dependencies.json`、`source-manifest.json` 和 `source-update.tar.gz` 保留。执行前源文件与依赖清单均核对，见 `records/source-verification.json`；本机再次核对运行快照为 66/66，见 `root-source-comparison.json`。这不是完整 Linux 安装、构建或全仓检查证据。

Linux 运行后有两个工具描述修改，涉及 `personal-browser.ts` 与 `personal-tools.ts`，没有更改 OS 执行逻辑；最终 64/66 相同，差异与指纹见 `final-source-comparison.json`、`final-source-difference.patch`。最终描述由 macOS 实际 provider 快照补验，不能将旧 Linux 快照声称为最终源码逐字相同。

## 真实 Chrome 前提失败

使用已有只读缓存中的官方 agent-browser 0.39.1 x64（SHA-256 `6906d3a2a67b05809932a93d99e53d1132373f0a52a617b2d6032dbb954df6fc`）、Chrome for Testing 155.0.8059.79 和缓存依赖库。默认沙箱启动失败，Chrome 报 `No usable sandbox!`，见 `records/chrome-prerequisite.log`、`records/chrome-prerequisite.json`；真实 browser 探针退出 1，见 `records/browser-probe.log`、`records/browser-probe-exit.json`。没有关闭沙箱、提权或修改主机安全配置。

因此 Linux 真浏览器未通过。恢复条件是提供可用 Chrome 沙箱的专用 Linux 环境，重新执行真实 browser 探针；不可用离线 56 项或 macOS 真浏览器替代。

## 材料与清理

`records.tar.gz` 的 SHA-256 为 `2fce28af84f6c360fc29785ebf55208ebb3a233cd7da69428653dfe129df689b`；本机逐项核对解出的 15 个文件，见 `local-archive-verification.json`。归档包含当时探针结果、环境、源码清单、原始日志和清理事实，没有包含 26MB 运行时副本。

下载并核对归档后删除本次专属 `/tmp/ruukoto-30-independent.QDMBbM` 和本次空控制目录，匹配进程为零，见 `remote-cleanup.json` 与 `records/cleanup-before-archive.json`。原有缓存及其他用户目录未清理。真实模型、IM 和产品体验均未在此环境执行。
