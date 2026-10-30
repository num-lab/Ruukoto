# 工单18 Linux隔离验证

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../git-history-cleanup/archive.md)。

- 时间：2026-10-17 UTC；主机 ssh tx（BJ-Tencent），Ubuntu Linux 6.8.0-117-generic x86_64，非root，Node v24.21.0 / npm 11.19.0；Python3/PTY、git、bash、g++、make可用。
- 源码目录：`/dev/shm/rk-18-linux-20261017T074832Z`；日志目录：远端及本机 `/tmp/rk-18-linux-20261017T074832Z`。仅写这些专属副本和测试自行创建/删除的唯一临时夹具，未操作真实服务或其他远端副本。
- 输入：根工作区实际tracked与未忽略untracked文件；排除`.git`、`.scratch`、`dist`、`worker`与所有`node_modules`，736个文件、11,766,929字节。远端独立git init/提交快照满足setup环境检查；依赖独立npm ci，未复制/复用已有node_modules。
- 首轮manifest：`source-manifest.jsonl`，SHA256 `514266c842bd540786e0707a0517b3e8d5b5fb1b0fa8de99886205365d9fcab3`。随后仅同步`test/personal-services.test.ts`和`test/personal-delegations.test.ts`，实际v2 manifest：`source-manifest-v2.jsonl`，SHA256 `816d89fa52719e6414ac8660bf59f59b93205719d782af0e534c91fe7e2c4a83`；捕获增量时根其余文件内容无差异。

| 命令 | 退出码 | 耗时 | 结果/日志 |
| --- | --- | --- | --- |
| `npm run setup -- --skip-hooks` | 0 | 30.671秒 | `setup.log`；两套锁文件各自npm ci。npm报告依赖审计与install-scripts提醒，完整输出保留 |
| `npm run build` | 0 | 1.696秒 | `build.log` |
| `RUN_MODEL_CHECK=0 npx tsx --test test/personal-durable.test.ts test/personal-cli.test.ts test/personal-services.test.ts test/personal-work.test.ts test/personal-work-tools.test.ts test/personal-work-controls.test.ts test/personal-work-notes.test.ts test/personal-delegations.test.ts test/personal-reports.test.ts test/personal-service-operations.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts` | 1 | 59.621秒 | `personal-tests.log`：334 tests，333 pass / 1 fail / 0 skip。唯一失败为personal-delegations旧菜单断言`/不包含服务/`与新“固定服务检查……不包含独立宿主服务写操作”文案不符 |
| `RUN_MODEL_CHECK=0 npx tsx --test test/71-product-entry.test.ts` | 0 | 31.061秒 | `entry-tests.log`：17 tests，17 pass / 0 fail / 0 skip，含真实bin后台进程 |
| `RUN_MODEL_CHECK=0 npx tsx --test test/personal-services.test.ts test/personal-delegations.test.ts` | 0 | 19.877秒 | `incremental-tests.log`：84 tests，84 pass / 0 fail / 0 skip，包含修正旧菜单断言和新增后台SIGKILL遗留真实检查进程回归 |

以上为首轮加最窄增量，没有把首轮失败改记为全量通过，也没有对未变文件重复执行。个人服务子进程/后台崩溃与锁/SQLite为真实Linux进程；模型走MockModelServer，服务helper/系统命令为测试桩，不属于真实模型、IM或systemd验收。

`final-audit.json`核对v2全部736个文件内容零差异；setup仅将两条bin权限由0755改为0775（内容哈希完全一致），属npm安装的mode变化，单独记录。symlink核对目标，跨OS的symlink mode不参与比较。

`processes-before.txt`、`processes-final.txt/json`保存进程前后证据；结束时不存在cwd或命令行归属本次源码副本的活动进程。对照前快照，最终仅新增审计本身及其SSH连接，没有测试遗留进程（包括僵尸）。已有后台PID2163755/2163766/2178158/2178169仍存活、命令与cwd仍为原/opt/ruukoto，未触碰。审计后的空间记录见storage-final.txt。

未跑全量npm run check、真实模型/IM/systemd或部署；本片对应Linux定向证据，不代表完整产品迁移验收。

2026-10-17T07:56:04Z清理：仅删除`/dev/shm/rk-18-linux-20261017T074832Z`专属源码/依赖副本，确认目录不存在、清理前后均无本轮活动进程；四个原/opt后台PID仍存活。远端与本机`/tmp/rk-18-linux-20261017T074832Z`日志保留，详见cleanup.json与storage-cleanup.txt。
