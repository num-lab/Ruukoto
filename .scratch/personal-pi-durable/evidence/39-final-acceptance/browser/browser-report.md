# 工单 39：Linux 浏览器前置与 owned 实验

结论：oracle-4c24g 的当前实际 BrowserManager owned 在独立空白测试档案完成启动、本机页面 snapshot、真实沙箱和停止核实，退出 0。供后续个人配置使用的 binaryPath 为 `/home/ubuntu/.local/ruukoto39/tools/agent-browser-linux-arm64-v0.39.1`，chromePath 为 `/opt/ruukoto39-chromium/chrome`。没有改仓库、依赖、live-profile 或隧道，没有启动真实 IM。

## 固定来源与安装

- agent-browser 为 [官方 v0.39.1 release](https://github.com/vercel-labs/agent-browser/releases/tag/v0.39.1) 的 glibc linux-arm64 原生资产。官方 API digest、实际下载 SHA-256 与 browser-manager.ts 固定值同时匹配 `9d8fdc586056df65747927ae166157c83af91b52cea287175e5544afd2591d33`；大小 15844112，`--version` 精确 `agent-browser 0.39.1`。未安装 npm wrapper。
- 独立 Chromium 取自 Microsoft Playwright v1.64.1 对应的官方固定版本 CfT 156.0.8078.4 / Chromium revision 1248，使用专用 tools 目录内 `playwright-core@1.64.1` 官方 CLI 下载 linux-arm64 资产。Playwright 官方支持 Ubuntu 24.04 arm64，CLI 的 dry-run 与下载记录固定 CDN URL；没有修改仓库依赖。[系统要求](https://playwright.dev/docs/intro#system-requirements)、[浏览器安装](https://playwright.dev/docs/browsers#install-browsers)、[固定 browsers.json](https://raw.githubusercontent.com/microsoft/playwright/v1.64.1/packages/playwright-core/browsers.json)。
- 按 ldd 只补 12 个缺失运行库和一个基础字体及其依赖，未安装 Playwright 完整 Xvfb/全部字体依赖组。前后 ldd、实际 apt 动作和浏览器版本均保存。
- 按根 Agent 审读后的精确方案，完整 Chromium 目录的 301 文件经逐文件 SHA 对比后安装到新的 root:root `/opt/ruukoto39-chromium`。目录 0755，资源 0644、可执行文件 0755，无组/他人写、无 setuid/setgid、无软链；不使用用户可写路径作授权目标。
- 仅新建 `/etc/apparmor.d/ruukoto39-chromium` 并通过 parser `-a -K` 加载这一项：`profile ruukoto39-chromium /opt/ruukoto39-chromium/chrome flags=(unconfined) { userns, }`，配 abi 4.0 与 global tunables。加载前证明目标、同名文件/已加载项及现有路径引用全不存在；加载后仅新增该一个 profile，无移除。没有重载整个 AppArmor，也没有更改 userns sysctl。

Ubuntu 官方支持按应用 profile 授予 userns；Chromium 官方文档 Option 2 给出该形态，并提示用户可写通配路径的风险，本次缩为 root 拥有的完整固定路径。[Ubuntu 原理与示例](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)、[Chromium 当前说明](https://raw.githubusercontent.com/chromium/chromium/main/docs/security/apparmor-userns-restrictions.md)。宿主 `/etc/apparmor.d/chrome` 与仓库 bwrap 的 profile 也为同一形态。

## 真实结果与保留失败

最初主机没有 agent-browser/Chromium，snapd 已存在。按 Canonical 官方入口安装的 strict Snap Chromium 155.0.8059.79/rev3560 完成本机 CDP snapshot；snap 包 SHA3-384 与 Canonical 签名 assertion 相符。真实沙箱和清理通过，但 Snap 私有 /tmp 使宿主 profile 目录仍空，不适配 BrowserManager owned 的 DevToolsActivePort 读取。这一成功只记为直接 CDP 前置，不拿来冒称产品 owned 通过。[Canonical 安装入口](https://snapcraft.io/install/chromium/ubuntu)。

独立 Playwright Chromium 在用户目录直接启动的首轮保留了实际 `No usable sandbox` / SIGABRT，来源为 Ubuntu AppArmor userns 限制，证据 `/tmp/ruukoto39-browser-isiyA7`；没有以 no-sandbox 或关闭限制绕过。之后才经独立审读安装上述 root-owned 精确路径与 profile。

当前实际 `packages/agent/src/browser-manager.ts` 在 `/tmp/ruukoto39-browser-owned-UwkDab` 执行 owned start，状态 ready，宿主 DevToolsActivePort 可见；Chrome、daemon 和 dashboard 均有独立已记录身份。本机 HTTP 页面 snapshot 含预期 heading/button；chrome://sandbox 明示 Layer 1 Namespace、PID/Network namespaces Yes、Seccomp-BPF/TSYNC Yes 和 adequately sandboxed。/proc 另核对命名 AppArmor profile、渲染进程独立 userns、NoNewPrivs=1/Seccomp=2；所有 Chrome argv 无 --no-sandbox。

manager.close 返回 true，状态 closed，已登记 Chrome 身份全部退出。最终对三次探针的 root 和产品生成的专用 socketDir 扫 /proc argv/env/cwd，匹配进程为零；socketDir 仅余 config.json。`kernel.apparmor_restrict_unprivileged_userns` 前后及最后均为 1；`kernel.unprivileged_userns_clone` 维持 1。测试 profile、资产与证据保留供复查。正式工具路径已交根 Agent，未访问或停止其 live-profile、真实 IM 或 SSH 隧道。

这里只验 Node 24.15.0、Linux aarch64 的本机真实 owned 浏览器与 sandbox。真实网站、登录、视觉模型、产品工具/权限组合仍由 39 后续流程验；没有把本次前置实验记为这些功能通过。
