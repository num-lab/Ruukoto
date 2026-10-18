# 工单 36：真实 Linux 对照与最终补验

本目录包含真实 Linux 版本对照、最终补验、环境与清理证据，可直接放入 `.scratch/personal-pi-durable/evidence/36-coding-regression/linux/`。本轮只使用测试副本，没有修改主工作区；远端唯一目录为 `/dev/shm/rk-coding36-linux.gaWtu6`。

环境与原 17 同为 tx 的 Linux 6.8.0-117 x86_64、Node 24.21.0、npm 11.19.0、UID 1003。两版由独立 git archive 提取，排除 `.scratch/`，分别 `git init` 和独立 `npm run setup -- --skip-hooks`，未共享 node_modules。基点 `a8fd60caceda3bbb243afff167a7c44751e749f4` 的 733 文件、原版当前 `3053bf6a3d1d9bab0c06ec61755b8723bb06dbff` 的 840 文件在运行前后均按 SHA-256 核实。两版 Pi 的 agent-core、ai、coding-agent 均为 0.85.1，tsx 4.23.13、esbuild 0.28.1、MCP client 2.0.0；完整解析见各版 `npm-tree.log` 和 `npm-paths.log`。

| 轮次 | 首次结果与解释 | 证据 |
| --- | --- | --- |
| 基点 setup 预检 | 退出 1，归档副本缺 `.git`，未进入 npm ci；补回原 17 的 git init 前提后继续 | `baseline-preflight-missing-git-evidence/` |
| 基点安装后的初次 122 | stdout 与 exit 文件均为 0 字节，执行结果及过程证据不可用；runner 写退出码时 ENOSPC，不能声称零请求、未执行或某个测试退出码 | `baseline-evidence/122-first.*`、`baseline-run.log`、`cache-cleanup-during-baseline.json` |
| 基点首次可用 122 | 1/1 通过，退出 0，测试 145.508 秒；明确修复测试空间前提后单独保留，未覆盖前述无效材料 | `baseline-controlled-space-evidence/` |
| 原版当前首次 122 | 1/1 通过，退出 0，测试 147.282 秒 | `current-first-evidence/` |
| 冻结补丁最小组 | 158 通过、1 个显式 macOS 平台用例跳过、0 失败，退出 0，169.217 秒 | `final-minimal-evidence/` |
| 冻结补丁首次 122 | 1/1 通过，退出 0，144.357 秒 | `final-122-evidence/` |

最终候选共 159 个唯一通过用例、1 个平台跳过；基点与原版当前的 122 是版本对照，不重复加到最终唯一用例数。唯一跳过为“macOS 身份有界重查只接受明确退出或完整身份，持续权限失败与损坏字段拒绝”，没有因缺 Python、PTY、模型或 Linux 前提跳过本组。

122 的精确命令为 `RUN_MODEL_CHECK=0 timeout --signal=TERM --kill-after=10s 300s npx tsx --test test/122-workflow-code-acceptance.test.ts`。每版 `TMPDIR` 分别为唯一目录下 `baseline-tmp`、`current-tmp`；测试阶段共同使用本次 `npm-cache`，并设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`。各测试轮 `command.json`、`result.json` 记录实际 argv、cwd、环境、时间、退出码与批次前后空间。`current-evidence/commands.json` 是安装开始时的阶段计划；实际构建环境以 `build-environment.json` 为准，实际测试环境以 `current-first-evidence/command.json` 为准，不能把安装所用根缓存套到构建/测试。最终最小组使用 `--test-concurrency=1` 串行运行 `100-worker-stop`、`101-native-execution`、`101-native-linux-scope`、`native-linux-identity`、`71-product-entry`、`24-mcp`、`25-mcp-write`、`mcp-transport` 八文件，122 始终单独运行。所有版本 `npm run build` 均退出 0，构建日志和 worker/desktop 产物 SHA-256 见各轮证据。

最终候选在原版当前上只覆盖已冻结的两文件：host SHA-256 `100f5842d48d55416f8398647ed6a790db924643b895fd7dfcf24d49c8f288c7`，test100 SHA-256 `f03f13862be3cf50ba60ccdbb5d0a1e75214475c4f7f9b92a3ff1c10fa99fa34`。`final-source-sha256.json` 记录完整 840 文件候选；`final-evidence/source-before-patch/` 保留原文件，`final-patch/` 为冻结补丁。原版当前测试结束并经 sudo 只读 /proc 扫描零本副本进程后才覆盖，未在原版运行期间改源码。

122 是混合执行路径：change 与宿主 Git 沿来源完全访问走 local；verify 由 `subAgentAccessPolicy(..., verify=true)` 强制 confirm/protectSource，Driver/Router 的 verificationLauncher 固定选择 native。完成断言覆盖五份真实修改、五次独立 bash 验证、冻结成果与最终汇总，并要求所有执行停止核实、占用清空。不能从会话 full_access 推断所有步骤都是 local。101/identity 另含策略与可控 scope 测试，不能扩称本轮新增专项跨重启或任意 systemd 恢复验收。

各 `final-snapshot.tar.gz` 是最后在途快照，通常采于约 30 秒，不是终态快照；当次 122 在 150 秒前结束，没有更晚采样。基点可用轮快照还包含初次无效空间轮的 fixture 根。旁路只读 SQLite backup 与 tar 不改变源码/测试档案；同一路径始终只保留一份 live tar 原子替换，结束仅改名最后在途快照。初次无效轮留下的 3.8 MiB 测试档案另存 `baseline-evidence/initial-no-space-test-files.tar.gz`，不能把文件存在解释为已知测试最终结论。

本次空间事件有独立材料：基点完整安装与 216 MiB npm 内容缓存曾耗尽 shm，释放本次 `_cacache` 后剩 225.6 MB，再启动首次可用 122；后者结束仍剩 225.3 MB。基点测试完成、安装树保存并由 sudo 只读 /proc 核实零进程后，仅移除本次基点两个 node_modules。当前独立安装使用唯一 `/tmp/rk-coding36-linux-npm.rhwyky` 缓存，先断言根分区可用大于 600 MiB；安装后只删其内容缓存，释放 233.7 MB，日志保留，测试环境回到相同 shm TMPDIR/cache。原版当前 122 前后空闲 143.7/138.4 MB；最终最小组前后 137.9/136.5 MB，最终 122 前后 136.4/136.3 MB。最终批次前置空间护栏为 64 MiB（按已观测增量选择的测试护栏），低于护栏即拒绝新批次。没有删除会话、失败现场、worker 或源码腾空间。

基点与当前的两个 node_modules 均已按授权移除；删除前已保存安装树、同步并核对证据，sudo 只读 /proc 扫描零本副本进程、零不可读，之后没有新增测试执行。当前清理释放约 1.54 GB 的 tmpfs 分配，剩余 shm 1,678,954,496 字节、根分区 926,674,944 字节；见 `current-dependency-cleanup.json` 与 `final-evidence/pre-dependency-cleanup-processes.json`。源码、worker、全部日志、安装树、最后在途快照、初次无效档案、编译缓存和唯一根缓存日志保留。两版依赖逻辑字节数一致，不能把不同时点全局 shm 余量差归因为依赖大小变化。SSH 曾间歇断开，两个后续长运行均用单次 nohup，不因断线重启测试。

原 17 Linux PID 3165125 在 2026-10-17 07:26–07:28 UTC 的 sudo 只读 journal 精确 PID 查询无条目（退出 0），同时间窗口 PID 数字词匹配无条目（退出 1 无匹配）；见 `original-17-journal-evidence/`。这些结果不能补出原始身份/ps/停止回执触发。基点与当前通过不能解释旧失败，迟帧反例也不能替代原调用证据；原 17 精确触发仍未知。

本轮未跑全仓 check、真实模型、真实 IM 或生产切换；只提供上述真实 Linux 同环境对照、当前调用方与最小回归证据，不据此关闭原 17 精确归因缺口。`summary.json` 提供机器可读结果；源码/产物清单、执行脚本、日志和传输校验供独立审查复核。
