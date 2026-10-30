Linux 隔离验证完成；主工作区全程只读。原始日志、基点至最终代码的 diff、逐文件 SHA-256、两次增量差异与执行脚本保存在[原始材料归档](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F14-linux%2Fraw-materials.tar.gz)，下文相对路径均指归档内路径。

基点为 `0c6f60c5a03b46f145e5737eacc07d82ce1fda3b`。首次冻结当前 tracked 与 untracked 文件共 1374 项、18,705,887 字节，排除 `.scratch/` 下旧 evidence；运输归档为 5,497,855 字节，SHA-256 为 `483ff95a44314faf3d281e6512a09cb5bd97481e9a6e98faced6d2801d4ece26`。运输包不入库，摘要保留于 `source.sha256`；最终代码差异见 `final-code.diff`。全部输入逐文件类型、权限、大小及摘要见 `input-manifest.json`，其中 34 份 personal 源码与测试另见 `runtime-input-manifest.json`。远端在安装前逐项核对全部输入，零差异；普通文件比较权限，符号链接不比较跨系统权限位。

环境为 `ssh tx`、Ubuntu 24.04.4 LTS x86_64、Linux 6.8.0-117-generic、Node v24.21.0、npm 11.19.0、Python 3.12.3、Git 2.43.0。根盘起始仅余约 669 MiB，故 `/tmp/rk14-yawd42p9/repo` 指向本次专属 `/dev/shm/rk14-yawd42p9/repo`；npm 缓存与 TMPDIR 位于本次 `/tmp` 专属目录。未修改或清理既有缓存、目录、服务和凭据。完整环境见 `provision.json`。

每个被检命令显式设置 `RUN_MODEL_CHECK=0`、专属 `npm_config_cache` 与 TMPDIR；完整命令、环境、开始/结束时间、退出码与 stdout/stderr 见 `remote-logs/`。第一次 setup 在安装前因运输快照缺 `.git` 被环境检查拒绝；保留 `setup-initial-no-git.*`，随后只在隔离 repo 初始化独立 Git 元数据后重跑。

- `npm run setup -- --skip-hooks`：exit 0，195.10 秒；按两份锁文件安装 847 与 269 个包。npm 11.19.0 提示部分 install scripts 未获 allowScripts 授权，本轮未主动跳过安装脚本；实际测试和构建结果如下。
- `npx --no-install tsx --test test/personal-durable.test.ts test/personal-cli.test.ts test/personal-services.test.ts test/personal-work.test.ts test/personal-work-tools.test.ts test/personal-work-controls.test.ts test/personal-work-notes.test.ts test/personal-delegations.test.ts test/personal-reports.test.ts test/personal-service-operations.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts`：exit 0，281 pass / 0 fail / 0 cancelled / 0 skipped，53.58 秒（runner 内部 52.74 秒）。
- `npm run build`：exit 0，1.95 秒；worker、脚本 worker 与双产品包构建完成。

首轮冻结后，根代理明确要求以当前 `personal-report.ts` 和 `personal-reports.test.ts` 做第一层增量，核实其余 32 份 runtime 文件 SHA 不变。增量包括发送领取事务读取当前配置、报告 checkpoint 尝试核对、取消与领取两个顺序及损坏 reply 拒绝恢复。原/新摘要、时间、授权与增量差异见 `input-overlay.json`、`overlay1.diff`；`npx --no-install tsx --test test/personal-reports.test.ts test/personal-service-operations.test.ts` 为 exit 0，69 pass / 0 fail / 0 skipped，13.93 秒；第二次 `npm run build` 为 exit 0，1.61 秒。该阶段新增 4 个唯一用例。

其后根代理明确要求仅增量更新 `personal-reports.test.ts`，加入本机菜单经真实控制接口查询完整报告与 Telegram 原菜单分页零模型用例；其余 33 份 runtime 文件 SHA 不变。原/新摘要、时间、授权与增量差异见 `input-overlay2.json`、`overlay2.diff`；`npx --no-install tsx --test test/personal-reports.test.ts` 为 exit 0，28 pass / 0 fail / 0 skipped，12.96 秒。第二层增量仅新增 3 个唯一用例，生产源码未变。

三阶段合计覆盖最终 288 个唯一用例，实际执行 378 次（281 + 69 + 28）；这不是一次完整 288 项运行。两个增量阶段分别由 `overlay1.diff`、`overlay2.diff` 定位，最终代码由基点及 `final-code.diff` 定位；最终全部输入清单为 `effective-input-manifest.json`，34 份最终 personal 输入为 `effective-runtime-input-manifest.json`。

最终本地 `final-effective-current-runtime-input-check.json` 与远端 `remote-logs/final-effective-runtime-input-check.json` 均核对全部 34 份 personal 源码与测试，SHA-256 与最终被检输入一致；文件集合核对也无增删。真实 SQLite、进程强杀恢复及原生 HTTP 路径已执行，模型、Telegram 与服务 helper 为离线替身。

首轮外层 SSH 运输进程返回 255，stderr 为 remote host closed；远端 `summary.json` 持久记录 setup/tests/build 均 exit 0。后续独立 SSH 成功回收完整日志并重新核实输入，运输异常另存 `transport-status.json`，未将外层 SSH 退出码当作被检命令成功。两次增量 SSH 均正常完成。

`cleanup.json` 与独立后查 `post-cleanup.json` 证实两个远端专属目录、缓存和临时目录均已删除，相关 cwd 进程为零；无需终止残留进程。清理后根盘余 699,518,976 字节、tmpfs 余 1,888,399,360 字节。未收集全量进程参数或环境变量。

未执行真实模型、真实 IM、真实 systemd、全仓检查或 Node 22.19/24.15 精确版本矩阵；本轮离线测试与构建不替代这些验收。
