# agent-browser v0.39.1 的真实环境探针

2026-10-14；用于工单阶段 0 的 CLI、Chromium 与进程事实，不代替产品 Runtime 或真实模型验收。使用官方未修改原生资产，校验见[release 记录](release-v0.39.1.json)。macOS arm64、Chrome for Testing 155.0.8059.79、宿主 Node 22.19.0/24.15.0；Linux 为 `ssh tx` Ubuntu 24.04.4 x64、Node 24.21.0、同版 Chrome for Testing。所有网页、密码与 Cookie 均为隔离合成夹具，没有真实账号。

## 结果

| 要求 | 实际执行与原始证据 |
| --- | --- |
| 跨次调用、profile 隔离与关闭 | [macOS 基础](macos-lifecycle.json)、[附接](macos-attached.json)；独立 profile 与 Cookie 分开，同会话页面跨进程调用延续；附接退出保留 Chrome 和标签 |
| 自有 Chrome 归属及强杀恢复 | [macOS](macos-owned.json)、[Linux](linux-owned.json)；宿主直接启动 Chrome，登记 PID、进程组与启动身份；daemon SIGKILL 后单独 CDP 关闭 Chrome，核实组退出后同 profile 的持久 Cookie 仍在；错 PID 身份不发送信号 |
| 空闲与人工输入 | [macOS](macos-idle.json)、[Linux](linux-idle.json)、[保存身份后的复核](macos-idle-identity.json)；显式 idle=1500ms 包括 CDP，dashboard 输入重置计时；daemon 退出后宿主关闭自有 Chrome，持久 Cookie 保留。缩短时间验证机制，未墙钟等待完整 60 分钟 |
| 丢响应不重发 | [macOS](macos-transport.json)、[Linux](linux-transport.json)；UNIX proxy 已接到 daemon 的成功点击响应后丢弃，分别注入 EOF、30 秒读超时及 Linux reset，CLI 返回结果未知，每项服务端 POST=1、点击发送=1 |
| 在途取消 | [macOS 取消](macos-cancel.json)；daemon 点击完成、响应被阻断时 SIGTERM CLI，原 POST 与点击发送均为 1；再按相同启动身份停止 daemon/Chrome 并核实退出，不重发原命令 |
| Linux 人工入口 | [SSH 转发](linux-dashboard-forward.json)、[Cookie 恢复](linux-cookie-recovery.json)；loopback dashboard 接收 50 个键鼠事件、17 帧，登录 POST=1，认证页与持久 HttpOnly Cookie 均核实；另一 namespace 的流端口请求 404 |
| 输入保真 | [官方 stdin batch](macos-stdin-batch.json)；填值 `--config` 作为命令正文传递，没有变为全局 CLI 管理参数 |
| 同用户原子占用 | [锁原语](shared-lock-primitive.json)；同产品/跨产品竞争仅一个 mkdir 成功，持有者强杀不自动解除未知占用。此记录只证明锁原语，目标规范化与实际管理器占用另由 `test/browser-lifecycle.test.ts` 和管理器真实探针验证 |

实际管理器及双产品组合证据另见[实现检查](implementation-checks.md)，包括 canonical UUID 锁与真实 SDK 图片传递。Node 22.19 与 24.15 分别通过 native 子进程调用、自有 Chrome 退出与持久 Cookie 复查。CLI 文件导出是独立产品证据，见[导出独立审查](export-independent-review.json)，没有把它算作真实视觉模型验收。

## 实测反例与路线调整

原版 CLI 的 daemon 被 SIGKILL 后留下 Chrome，立即重开触发 SingletonLock；因此 Runtime 直接持有自有 Chrome，CLI 只做显式 CDP 连接。附接 Chrome 不登记为宿主回收对象。只发 SIGTERM Chrome 曾丢失新 Cookie，正常 CDP `Browser.close` 后则保留，所以正常关闭须先走 CDP 并按实际进程结果核实。

`close` 的成功应答早于 daemon/Chrome 实际退出；Linux 紧接着 `open` 真实遇到 EOF/outcome_unknown，原操作没有再发。必须核实旧进程退出后才允许复用。新开的 about:blank 上 `cookies get` 只查当前页范围，空结果不能证明 profile 登录丢失；浏览器级 `Storage.getCookies` 复查证实持久 Cookie 存在。

外部 CDP 默认免除自动 idle，显式 `AGENT_BROWSER_IDLE_TIMEOUT_MS=3600000` 才纳入。宿主监督只查进程身份，不发 CLI 命令保活。上游未给常规选择器失效提供可靠结构码，因此工具先按已暴露代次的 ref 与新 snapshot 判别已知失效；动作发送后的通用失败保守记未知效果，不按错误文本判别安全重试。

## 复现

准备固定官方 native 与 Chrome 后，仓库根目录运行下列隔离脚本。输出打印专属临时目录；该目录保留 JSON 结果、截图、profile 和命令记录。脚本不修改 Ruukoto 档案。

```bash
python3 .scratch/agent-browser/probes/lifecycle.py "$BROWSER_BINARY" "$BROWSER_CHROME"
python3 .scratch/agent-browser/probes/owned-lifecycle.py "$BROWSER_BINARY" "$BROWSER_CHROME" node
python3 .scratch/agent-browser/probes/owned-idle.py "$BROWSER_BINARY" "$BROWSER_CHROME" node
python3 .scratch/agent-browser/probes/transport-fault.py "$BROWSER_BINARY" "$BROWSER_CHROME"
python3 .scratch/agent-browser/probes/cancel-native.py "$BROWSER_BINARY" "$BROWSER_CHROME"
```

Linux 原始夹具在远端 `/tmp/ruukoto-agent-browser-0391-linux-hPuoYRCD`；本机保留副本 `/tmp/ruukoto-linux-lifecycle-evidence/`、`/tmp/ruukoto-linux-dashboard-evidence/`、`/tmp/ruukoto-linux-owned-evidence/` 与 `/tmp/ruukoto-linux-idle-evidence/`。组合脚本末版仅做语法核实，已执行的各部分记录是事实依据，不能声称组合末版整跑通过。

## 环境缺口

[Linux 前提与清理](linux-preparation.json)：测试时持久磁盘仅余 137 MiB，Chrome 缺系统库且 Ubuntu AppArmor 拒绝默认 sandbox。探针在临时目录解包依赖、用 `/dev/shm` profile 并显式设置 `BROWSER_PROBE_NO_SANDBOX=1` 校准；没有系统安装、提权或生产自动回退。测试进程已清理，资料副本保留。该结果证明接入机制，生产启用仍需磁盘、依赖与可用 sandbox。

未验证真实账号、Linux Node 22、OS 重启、真实视觉模型和拥有者实际人工体验。标准无 expires 的会话 Cookie 在默认 Chrome 关闭后不保证保留，持久 Cookie 已有正向证据；不额外导出密码/Cookie 正文或用 restore 重放页面。
