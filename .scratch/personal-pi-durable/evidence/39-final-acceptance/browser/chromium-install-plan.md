# Chromium owned 安装方案

固定资产：Microsoft Playwright v1.64.1 官方 tagged browsers.json 中的 Chrome for Testing 156.0.8078.4，Chromium revision 1248，linux-arm64。现有下载目录 `/home/ubuntu/.local/ruukoto39/tools/playwright-browsers/chromium-1248/chrome-linux-arm64`。已通过官方 CLI 下载、宿主 ldd 补齐系统库并核对 `--version`；在 AppArmor userns 限制下默认启动的原始失败保留 `/tmp/ruukoto39-browser-isiyA7`。

安装将完整目录复制到一个新建的 root 私有暂存目录，逐文件 SHA-256 与源清单相符后，设 root:root、目录0755、普通资源0644、原有可执行文件0755（不保留任何setuid/setgid）；原子更名为此前不存在的 `/opt/ruukoto39-chromium`。正式 Chrome 路径仅 `/opt/ruukoto39-chromium/chrome`；不使用软链、wrapper或用户可写目录作 AppArmor attach 目标。`/opt` 已核实 root:root 0755。

精确 profile 为同目录 `ruukoto39-chromium.apparmor` 的内容，将新建为 `/etc/apparmor.d/ruukoto39-chromium`（root:root 0644），只声明该完整 Chrome 路径的 `userns,`。已只读确认目标目录、profile文件、所有现有profile中的该路径/名称引用和已加载同名profile均不存在。加载前再次核对这些条件，若出现就拒绝覆盖。只用 `apparmor_parser` 加载这一个profile，不重载/停止整个AppArmor服务。

官方依据：Ubuntu官方说明用每应用AppArmor profile和userns规则保留整机userns限制：[Ubuntu公告](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)。Chromium官方文档的 Option 2 给出 `flags=(unconfined)` 配合 `userns,` 的按路径配置，并警告用户可写/通配路径会扩大允许范围；本方案使用root-owned完整固定路径：[Chromium文档](https://raw.githubusercontent.com/chromium/chromium/main/docs/security/apparmor-userns-restrictions.md)。宿主当前 `/etc/apparmor.d/chrome` 与仓库 `deploy/native/ruukoto-bwrap` 也采用同一形态。

验证：保持 `kernel.unprivileged_userns_clone=1` 和 `kernel.apparmor_restrict_unprivileged_userns=1`，不增加 `--no-sandbox`。先在专用/tmp档案经当前实际 BrowserManager owned 启动，核对宿主 DevToolsActivePort、精确profile label、独立渲染userns/Seccomp2；浏览器读取本机HTTP页面snapshot及chrome://sandbox。结束由manager核实自有Chrome/daemon/dashboard退出，保留profile与浏览器资产用于后续39验收；不访问或停止live-profile/隧道。
