# 工单 20 Linux 独立验证

Status: 本片 Linux 验证通过，专属目录已清理

环境：Ubuntu 内核 6.8.0-117-generic / x86_64，Node 24.21.0，npm 11.19.0，执行账户 eitrous（uid 1003）。全部模型、Telegram 与 systemd 服务均为离线替身；Linux HTTP 用例使用实际 Unix socket、生产 useSudo/-n 路由及专用 sudo 可执行命令桩，不是系统 sudo 提权或真实 systemd 证据。

输入快照 tar SHA-256 `fcdffd703fb4f466e94cc5bb7b8e96faac192e7d87036dca2d477c27cb0d3025`，原始 1390 文件清单 SHA-256 `fb9d5b7892dd30a76be2d2732e8de1670cce666ec59a4c3a0674080f57687224`。原始内容全部核对通过。父 agent 先后提供三文件来源/测试时序增量（increments.json）与三文件展示文案/断言增量（increment-wording.json），最后仅同步 service-operations 测试等待两条停止证据的增量（increment-stop-sync.json）。重叠后共五个文件更新；tested-manifest-first-pass.json 与 tested-manifest.json 保存实际验证内容。末轮另同步新增测试决定笔记，总计1391文件全部匹配；作者最终17文件清单亦全部匹配（SHA-256 `8d3dbd438f576f7f10e073fc83b53d8b8b105467eeea1cb9d1dabfbdd7c371c2`）。

源副本入口 `/tmp/rk20-linux.qLIxtpYE/repo`，实际源码与依赖位于本次专属 `/dev/shm/rk20-deps.pW7jZIhE/repo`。根盘初始仅余约595 MiB，tmpfs余1.8 GiB，因此使用可执行tmpfs，不动现有目录/缓存。TMPDIR为`/tmp/rk20-linux.qLIxtpYE/tmp`。setup结束后仅删除本次npm-cache/_cacache约216 MiB，避免tmpfs满。首轮setup因tar无.git被环境门禁拒绝；仅在专属副本git init后重跑成功。两次记录均保留。

## 实际检查

| 检查 | 结果 |
| --- | --- |
| 初始1390文件哈希 | 全部匹配 |
| `npm run setup -- --skip-hooks` | 初次无.git拒绝；初始化副本Git后通过，约198s |
| `npm run build` | 首轮通过，最后展示文案增量后再次通过 |
| pre-push指定12个personal文件 | 363/363，0跳过，约65s |
| `npx tsx --test test/71-product-entry.test.ts` | 17/17，约32s |
| 最后增量：service-operations、cli、telegram-permissions三文件 | 首轮113/114，1失败；同内容重复114/114 |
| 上述失败单例同内容重复 | 5/5通过 |
| 最后仅同步测试等待两条证据：service-operations整文件 | 53/53通过 |
| 最后测试同步修正后的单例重复 | 连续3次1/1通过 |

12个personal与product-entry合计380个唯一场景，不叠加后续重复。完整命令、起止时间、exit code见steps.jsonl，原始输出按同名.log保存。真实Unix socket+sudo命令桩/慢stop不阻塞独立聊天、新service-stop实际SIGKILL恢复、旧子检查强杀固定原引用均通过。

## 保留失败

最后三文件首轮中，`personal-service-operations.test.ts:84` 的“错误证明保留占用”断言期望launcherStopped=false、实际true；首轮12文件中该场景通过，单独5次与同内容三文件重复均通过，尚未将重复通过等同于已定位或已修复。源码存在原服务verify的stop-op与显式重核并发：原测试仅等待后者结束即移除stop-query-fails并切换helper，尚在途且已加载旧代码的调用可提交可信退出证明。父agent随后仅补齐等待该requestId两条stop-op证据都提交的同步和原因注释，保留错误机器应答与全部既有断言。该单文件末轮53/53及修正单例连续3次通过；不修改生产停止判别。原失败完整保存在focused-final.log，不以重复通过抹去。首轮没有逐次调用时间线，因此不能断言该次失败必由此窗口引发；代码及独立审查证明两证据同步关闭该窗口，仍保留首轮根因的不确定性。

## 证据归档

少量原日志有行尾空白；阅览副本只规范行尾，完整原字节及 SHA-256 由 artifact-storage.json 标明。四份全量进程快照含无关后台的命令行凭据，原件与对应 gzip 已移至仓库外的 0700 目录，文件为 0600；仓内副本将整条无关凭据进程记录脱敏，不在仓内保留含凭据原字节。变换不涉及测试结论、17 源文件、原始内容哈希或七条既有 Ruukoto 进程比较，证据校验和按最终可入库材料重建。

## 清理与边界

首轮结束后对/proc argv、cwd、environment扫描未发现本次专属路径的存活进程；与初始ps比较无新增僵尸。最终再次扫描/proc argv、cwd、environment，未发现本次专属路径的存活进程；与初始ps比较无新增僵尸。7条既有/opt/ruukoto后台及其父子PID/命令均保持原状（process-comparison.json）。已删除本次专属/tmp目录、TMPDIR、tmpfs源码/依赖/cache，cleanup-verified.json核实两个根路径均不存在。未向既有进程发信号。

未跑全仓check、远端静态门禁、真实模型、真实IM或真实systemd；没有切换正式入口、修改主工作区或触碰现有后台。
