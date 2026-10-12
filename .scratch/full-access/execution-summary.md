# 当前账户执行与停止验收

验收使用临时目录、虚拟凭据与模拟模型；后台 Runtime、SDK、工具 worker、文件、进程、目录身份、SQLite、socket 与本机 HTTP 均为真实执行。没有读取真实凭据，没有修改真实账户、系统单元、策略或生产部署。

## 两平台当前账户

最终环境过滤只清除 `RUUKOTO_OWNER_TOKEN`、`RUUKOTO_OWNER_TOKEN_FILE`、`RUUKOTO_CONTROL_DIR`、`RUUKOTO_CODE_CONTROL_DIR`。其余用户环境与宿主 Git 环境保留，包括验收新增的 `RUUKOTO_USER_TOOL_OPTION`；该键与四个控制键均由真实 worker 内断言核实。以下输出来自修正明确过滤清单后的复跑。

| 平台 | 实际身份与前提 | 原始输出 |
| --- | --- | --- |
| macOS 本机 | arm64，Node 24.15.0，UID 501 / GID 20；原生受限对照使用构建出的宿主监督器 | [macos-current-account.txt](macos-current-account.txt) |
| tx Linux | x64，Node 24.21.0，UID 1003 / GID 1003；原生受限对照使用现有 `/usr/bin/bwrap` 与 user systemd scope；本次未修改平台前置 | [linux-current-account.txt](linux-current-account.txt) |

复跑入口：`npx tsx .scratch/full-access/verify-current-account.mts`。Linux 将源码复制到独立 `/tmp/ruukoto-full-access.aDqwUt` 并安装锁定依赖，修正环境过滤时只更新 launcher 与验收脚本；临时实例、任务目录、虚拟资料及本次独立检出均已清理。依赖安装原始记录见 [linux-setup.txt](linux-setup.txt)。

两平台分别验证两个产品配置的真实任务：`ruukoto-code` 的 native 配置与 `ruukoto` 的 container 配置均在 full_access 下使用启动账户，无旧账户配置或执行启停包装。UID/GID、HOME、PATH 中的临时命令、代理、SSH agent、虚拟工具凭据、普通 Ruukoto 工具环境均符合后台环境；工作区外虚拟凭据可读、外目录可写、本机 HTTP 可达，零审批。

停止验证包含独立 Shell 进程组和忽略 TERM 的同组后代，停止成功后心跳不再增加。强杀 worker 的另一例没有命令组停止应答，宿主如实返回 false，重复停止仍 false、`worker_stop_unverified` 保留；残留的本次测试命令组由脚本显式清理。受限 native 对照实际拒绝外部文件与网络。

网络证据为本机真实 HTTP，不声明验证了任意公网站点或真实代理/SSH服务。虚拟环境值只用于继承断言；未尝试真实凭据、真实模型、真实消息平台或当前账户的 root 服务部署。

## 定向回归与构建

| 检查 | 结果与原始输出 |
| --- | --- |
| macOS `npx tsx --test test/100-worker-stop.test.ts test/101-native-execution.test.ts` | 36/36，[execution-tests.txt](execution-tests.txt) |
| Linux 同一执行/停止检查 | 36/36，[linux-execution-tests.txt](linux-execution-tests.txt) |
| `npx tsx --test test/73-desktop-execution.test.ts test/71-product-entry.test.ts test/32-dev.test.ts` | 49/49，[execution-product-tests.txt](execution-product-tests.txt) |
| `npx tsx --test test/10-access-modes.test.ts` | 15/15，包括当前摘要重试、模式变化与旧摘要拒绝，[access-mode-tests.txt](access-mode-tests.txt) |
| `npm run build:worker` | 通过，[build-worker.txt](build-worker.txt) |
| 使用同一 Dockerfile、清除构建代理的 `docker build` | 通过，生成 0.85.1 / latest，[build-worker-image-direct.txt](build-worker-image-direct.txt) |
| `npx tsx verification/smoke/smoke-04-desktop-execution.mts` | 6/6，真实 Docker Desktop 容器、文件/网络边界、结构化审批、完全访问提交与中断回收；模型为桩，[smoke-04.txt](smoke-04.txt) |
| 文档预算与段落检查 | 通过，[doc-budgets.txt](doc-budgets.txt)、[doc-wrap.txt](doc-wrap.txt)；最终链接与笔记转换后静态检查由总验收持有 |

[build-worker-image.txt](build-worker-image.txt) 是默认 Docker 构建代理指向容器内 127.0.0.1 导致 npm ECONNREFUSED 的环境诊断，不计为构建通过。后续 [build-worker-image-proxy.txt](build-worker-image-proxy.txt) 与 direct 记录均成功，最终 smoke 使用 direct 构建后的镜像。`execution-entry-tests.txt` 包含退役旧摘要接受规则之前的 63/64 中间结果，最终以 15/15 的 access-mode 检查及 49/49 的产品检查为准。`execution-typecheck.txt`、`execution-lint.txt` 与早期 doc-check 输出来自并行施工中间态，不代表最终静态验收。

## 停止与信任范围

完全访问不施加任务沙箱，因此同账户后台数据、凭据与控制面令牌都处于已接受的可访问范围。接口的资料归属、输入校验与固定服务白名单仍有效，但不能阻止自由命令访问该账户已有的资源。

停止覆盖已登记的命令组与 worker 原组；没有应答、查询失败或残留就保留未知结论与目录占用，不把主 PID 退出当作整项停止。主动脱离已登记组、另行提权的进程和外部服务不保证随任务停止；取消或模式切换不撤销已产生的外部效果。受限 native/container 保留各自的平台监督，不因完全访问的共享启动路径静默降级。
