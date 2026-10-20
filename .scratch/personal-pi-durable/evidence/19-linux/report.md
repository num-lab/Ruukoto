# 工单19 Linux 隔离验证

入库时 `.log`、`.txt` 与 `.jsonl` 按原名加 `.gz` 压缩，内容不变；报告中的原始文件名对应同名压缩文件。源码 tarball 未入库。

2026-10-17 UTC 在 ssh tx（BJ-Tencent）执行，Ubuntu Linux 6.8.0-117-generic x86_64，非 root，Node v24.21.0 / npm 11.19.0，Python3 PTY 可用。按 AGENTS.md 与 pre-push-checks 选定个人 durable 相关12文件和产品入口，不运行全仓 check。

独立源码目录 `/dev/shm/rk19-linux-20261017T082256Z`，独立测试 TMPDIR `/dev/shm/k19t-082256`，远端日志目录 `/tmp/rk19-linux-20261017T082256Z`。仅从当前主树拷贝738个 tracked/未忽略 untracked 文件，排除 .git、.scratch、node_modules、dist、worker。独立 git init/快照提交后 setup 两套锁文件 npm ci；未复用已有 node_modules。主树源码没有修改，既有远端部署、数据库和后台没有操作。

首轮源码 manifest SHA256：`7220363210d0f10549d17cf1707fa57ad78aca1ebd811cd4f5640e774547fb33`。上传前与主树逐文件内容一致，包含检查控制守卫修正及前12项新重核检查，尚不包含随后新增的 SIGKILL 用例与生产 sudo 用例中的新重核路由。

| 命令 | 退出码 | 耗时 | 结果与日志 |
| --- | --- | --- | --- |
| `npm run setup -- --skip-hooks` | 0 | 195.850秒 | `setup.log`；独立冷下载，依赖审计/install-scripts 提示原样保留 |
| `RUN_MODEL_CHECK=0 npx tsx --test --test-name-pattern=检查重核 test/personal-services.test.ts test/personal-cli.test.ts` | 0 | 6.113秒 | 12 tests，12 pass / 0 fail / 0 skip；`inspection-controls-targeted.log` |
| 个人 durable 12文件全量（完整 argv 见 `summary.json`） | 0 | 59.567秒 | 347 tests，347 pass / 0 fail / 0 skip；`personal-tests.log` |
| `npm run build` | 0 | 1.809秒 | `build.log` |
| `RUN_MODEL_CHECK=0 npx tsx --test test/personal-services.test.ts test/personal-cli.test.ts` | 0 | 25.241秒 | 增量后94 tests，94 pass / 0 fail / 0 skip；`incremental-two-files.log` |
| `RUN_MODEL_CHECK=0 npx tsx --test --test-name-pattern='prepare.*取消|取消.*prepare' test/personal-service-operations.test.ts` | 0 | 2.546秒 | 1 test，1 pass / 0 fail / 0 skip；`service-operation-cancel-recovery.log` |
| `RUN_MODEL_CHECK=0 npx tsx --test test/71-product-entry.test.ts` | 0 | 31.924秒 | 17 tests，17 pass / 0 fail / 0 skip；`entry-tests.log` |

分轮合计覆盖365个唯一样例：首轮个人基线347项、产品入口17项和新增SIGKILL1项；两文件94项为重叠增量复验，不累加到总数。所有实际执行均通过，未跳过用例。

个人12文件为 personal-durable、personal-cli、personal-services、personal-work、personal-work-tools、personal-work-controls、personal-work-notes、personal-delegations、personal-reports、personal-service-operations、personal-telegram、personal-telegram-permissions 的 `.test.ts`。其中既有“prepare 取消后检查未核实仍占来源与目标，恢复和终态不能绕过”在首轮集合和补单例均通过，未在本轮 Linux 复现 macOS 并发首轮报告的失败。

v2/v3/v4 分别记录 SIGKILL 测试、新生产 sudo 路由测试、该路由测试尾部零调用断言的前提修正；这三次仅涉及两个测试文件，在首轮完成后一起顺序应用，再运行两文件94项，不把中间未执行的快照记作通过。v4 完整 manifest SHA256 为 `4ef2e36083e9d3155a19fc347c74acb95a06f72a2f46f1be170c0fcef5dbcaf7`，增量前后内容核对零差异。产品源码始终没有增量，因此沿用首轮构建证据。v5/v6 只有 personal-durable 模块文档增量；v5 后执行产品入口17项，v6 后最终审计738文件内容零差异，实际 Linux 被检快照 v6 的 manifest SHA256 为 `122f60843ac8e44fce8ae590612ebd0201c85ea6b17a88bd22b04a14c54167ae`。各次完整清单与差异均保留，源码归档仅留本机 `/tmp/rk19-linux-evidence` 供溯源，不必入库。

远端清理后，最终主树 `apps/ruukoto/src/personal-inspection-controls.ts` 又机械删除未使用的 `BACKGROUND_CONTEXT` import 和对应 const，共2行；其他实施文件没有变化。v6 是上述 Linux 实际验证的源码快照，最终主树此文件与 v6 不同，738文件零差异仅指清理前远端内容对 v6 清单的核对结果，不代表当前主树与该快照完全一致。这2行删除没有重建远端目录或重跑 Linux；对应主树追加检查由主代理负责。原快照和各版 manifest 均未改动。

生产 sudo 用例在 Linux 上实际启动 detached 个人后台，经真实本机 Unix socket、拥有者令牌、真实子进程执行新增检查路由；验证无效参数/admission 拒绝、helper 文件 gate 阻塞时 CLI 登记已返回且 GET 仍可读，释放 gate 后清除 pending 且未重新 inspect。SIGKILL 用例实际杀死收件提交后、返回调度前的子后台，断言退出 signal 为 SIGKILL，重开恢复同一重核 Task 与收件且不重复登记。服务 helper、sudo 和 Telegram HTTP 使用测试桩，模型使用 MockModelServer；这些通过不构成真实 systemd、模型或 IM 体验验收。

setup 后独立冷 npm 缓存一度使 /dev/shm 只剩18MB；确认 setup 完成后仅删除本次 `.npm-cache/_cacache` 下载缓存221433804字节，释放到243380224字节，再继续离线测试和构建；记录见 `setup-cache-cleanup.json`。没有删除安装依赖或改任何既有缓存。最终源文件内容完全一致，setup 仅将两条 bin 权限由0755改成0775，见 `final-audit.json`。

最终进程审计仅有本次审计程序及其 SSH 连接是相对前快照新增的进程，未留下测试活动进程或僵尸。原 `/opt/ruukoto` 后台 PID 2163755/2163766/2178158/2178169 均存活、命令与 cwd 不变。2026-10-17T08:29:28Z 已删除独立源码/依赖、测试 TMPDIR 与缓存，确认两个目录不存在且无残留进程；见 `processes-before.json`、`processes-final.json`、`final-audit.json`、`cleanup.json`、`storage-cleanup.txt`。

日志与归档已下载本机 `/tmp/rk19-linux-evidence`，逐文件 SHA256 对照远端下载清单零差异（`download-verification.json`）。2026-10-17T08:30:10Z 删除本次远端日志专属目录，最终复核源码目录、TMPDIR 与远端日志目录均不存在，四个原后台仍在；见 `remote-log-cleanup.json`。本机日志保留供主代理整理入库。

未跑全量 npm run check、Linux 静态门禁、真实模型/IM/systemd、部署或正式入口切换；本片仅提供明确命令和快照的 Linux 独立验证证据。

Linux 验证完成后的最终局部整理还包括：把新检查控制模块两处 try 的主体提为局部函数，try 只等待一条语句，调用顺序与失败分类不变；本机对最终代码运行静态、构建和13个重核用例，Linux未重复。v6 清单仍仅表示实际被检内容。
