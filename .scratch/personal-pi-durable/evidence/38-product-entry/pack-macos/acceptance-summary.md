# 工单 38 隔离安装与实际打包验收

验收副本 `/tmp/ruukoto38-pack-20261018-1`；证据目录 `/tmp/ruukoto38-pack-evidence-20261018-1`。macOS 27.0.1 arm64、Node 24.15.0、npm 11.12.1。基点 `12b1a66cfa661f2a8bddaa9405283ab9f22cb20c` 加主副本当时 tracked diff 和三个必要 untracked 文件；未复制任何 node_modules。4,045 项源清单在安装、构建、解包替换和测试后仍逐字节相符，包含 8 个退出路径，详见 source-manifest.json。

`npm run setup -- --skip-hooks` 返回 0，用时 9.622 秒，执行根与 foundation 的独立 npm ci。`npm run build` 返回 0，用时 1.114 秒，独立生成共享 worker、个人命令 worker、工作流脚本/WASM、macOS 监督器和两个 app tarball。

实际解开构建所得 tgz，替换副本 apps 内 src、bin 和 package.json，保留新安装的 node_modules。个人包 75 个成员，Coding 包 6 个成员，每个文件都按 archive 成员 SHA-256 核对。个人包不含退出的 product/scheduler-tools/service-tools；workspace 内旧个人 personal-import 已不存在；Coding 自身 product 保留。完整安装的 workspace、包链接和根 worker 均位于本隔离副本，未链接主工作副本依赖。

在这个确实使用 tgz 源码、新安装依赖和独立构建 worker 的 workspace 上执行 `RUN_MODEL_CHECK=0 npx tsx --test test/personal-entry.test.ts test/personal-command-worker.test.ts`，返回 0，12/12 通过，无失败或跳过，用时 19.598 秒。覆盖实际正式 bin、根 start、兼容入口、双产品同时运行与 schema 保持、旧档案拒绝、双进程拒绝、启动中关闭及 SIGTERM/SIGHUP、开发档案隔离/IM 拒绝/源码重载和自包含 worker 的实际执行。

独立解析探针确认个人 pi-ai/durable/chord 均为 1.3.0，Coding pi-ai/pi-coding-agent 均为 0.85.1，实际解析路径在本副本内。解包后 personalCommandEnvironment 中的默认 worker URL 静态解析为根 `worker/personal-command-worker.mjs`，产物 SHA-256 为 `c1d8bc3492be8253ce5bdf4ed5dc553e44da91fc3eda4be663eddd7d49e63cf3`；上述 worker 用例实际运行同一根产物的复制件。personalCommandEnvironment 是 Linux 专用，macOS 本轮未调用该函数，不把静态路径核对称为真实 Linux 命令装配验收。

测试后 7 项 worker/tgz 制品哈希保持。按本副本路径只读匹配 node/npm/tsx 命令行无残留；该扫描不构成全系统后代停止证明。主副本相对本快照的变化记录于 origin-comparison.json：[".agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md", ".agents/skills/pre-push-checks/SKILL.md", "docs/architecture.md", "docs/development.md", "docs/modules/agent-context.md", "docs/modules/agent-tools.md", "docs/modules/channels.md", "docs/modules/deploy.md", "docs/modules/scheduler.md", "docs/modules/tui.md", "docs/usage.md", "packages/core/src/product.ts", "verification/smoke/smoke-04-desktop-execution.mts"]。

上述漂移中的两个 TypeScript 文件仅变动注释，去注释编译后的 JavaScript 相同，见 runtime-origin-comparison.json；其余为文档和 skill 文本，原始快照仍为本证据的精确对象。

两次验证脚本自身的首轮错误保留：解包验证器最初把 canonical /private/tmp 路径与 lexical /tmp 比较；测试后进程扫描最初按严格 UTF-8 解码系统 ps 输出。两者均修正验证器后通过，没有改产品或重跑失败产品用例。

交付仍要求完整 workspace 安装和根 worker，app tgz 不是独立可安装发行版。本轮未运行 122、其他 native SDK 重例或全仓检查，未验真实模型/IM、Linux 命令环境和生产接管；36 原 17 精确归因缺口不由本证据关闭。未提交，临时副本保留待终审。

可拷入证据的文件：

- `environment.json`
- `source-manifest.json`
- `source.patch.gz`
- `setup.log`
- `setup-status.json`
- `build.log`
- `build-status.json`
- `ruukoto-tar-manifest.json`
- `ruukoto-code-tar-manifest.json`
- `ruukoto-0.1.0.tgz`
- `ruukoto-code-0.1.0.tgz`
- `unpack-products.py`
- `unpack.log`
- `unpack-status.json`
- `unpack-verification.json`
- `unpack-attempt-1-status.json`
- `packed-tests.log`
- `tests-status.json`
- `dependency-probe.mjs`
- `dependency-resolution.json`
- `artifact-manifest-before-tests.json`
- `artifact-manifest-after-tests.json`
- `post-test-probe.py`
- `post-test.log`
- `post-test-verification.json`
- `post-test-attempt-1-status.json`
- `origin-comparison.json`
- `runtime-origin-comparison.json`
