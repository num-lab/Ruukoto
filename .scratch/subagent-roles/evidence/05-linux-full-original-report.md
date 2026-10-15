# 工单 05 Linux 最终源码原完整检查

固定输入为主区最终源码清单 v1，SHA-256 `d8bd734f058d66136df514b88d6d8d49181adb8383c528d24d7e688a783a0c5d`，620 项（619 普通文件和一个符号链接）。在本次唯一隔离副本覆盖真实仓库所需的 1,552 项输入，并保留通过文档链接检查所需的全部 115 项 .scratch 材料；31 个历史压缩证据包不被 Markdown 直接链接，单列排除，未据此改链接。完整传输归档 SHA-256 `5e7e914a51b07c6ccdcc918225e80ebd0222daa983143b0247d77038ed23023e`，实际归档、清单、排除项与文档扫描程序均附。

原命令为 `npm run check`，未改 runner、并发、内存预算、超时或重试。工作目录 `/dev/shm/rk05-linux.ZHrgZC/repo`，临时目录与 npm 缓存均在本次私有根下，真实模型固定关闭。Node 24.21.0、npm 11.19.0、Linux 6.8；正式 user systemd/cgroup/bwrap 前提与 setup/build 已在原 Linux 基线取证。完整检查前仅删除本次自己的 161,764,873 字节 npm 缓存，未清其他目录或修改系统配置；环境前后余量记录附。

03:49:06.932–04:14:14.173 UTC，原完整检查退出 1，实际 1507.241 秒。build、lint、各包与 foundation typecheck、notes 和全部 docs 门通过；应用测试 tests 1658、pass 1640、fail 5、cancelled 0、skipped 13、todo 0，应用内部耗时 1371.589 秒。应用失败导致 npm test 原脚本短路，foundation 没有作为该次完整检查的一部分执行。随后在相同 v1 源码独立执行 `npm run test:foundation`，9 通过、0 失败、1 跳过（真实模型 gate），退出 0，8.586 秒；不可把两次命令写成完整 check 通过。

| 原完整检查失败 | 实际最后断言 |
| --- | --- |
| test/10-access-modes.test.ts:621 | 期待 /父级/，实际在真实 /var/lib/ruukoto/service-ops scandir 得 EACCES；未读取目录内容或改权限 |
| test/122-workflow-code-acceptance.test.ts:46 | 六输入整项回报原 90 秒 waitFor 超时；快照保留 verify3 running、verify5 queued |
| test/125-agent-wait-resource.test.ts:204 | 父级注入 accepted 为 0，期望 1；旧夹具直接注入同会话裸 Task |
| test/14-tui-app.test.ts:615 | 正文已完整恢复，后续 48KiB 分页请求的 requests.some 断言为 false |
| test/84-im-final-delivery.test.ts:483 | 期待唤醒 completed 的旧夹具等待超时；来源停用时实际应由新门拒绝 |

完整原栈、包括六输入失败时的任务/工作流状态均在原 stdout/stderr 中。后续三条 test-only 夹具修复及 14/122 原窄复核另列增量证据，不改变这次 v1 原红结果。

结束后全部 1,552 项输入字节/链接目标逐项一致，v1 冻结 620 项全匹配，Git 工作树干净。三实际编译物 worker.mjs / workflow-script.mjs / workflow-script.wasm SHA-256 与原基线相同，完整字节与哈希均附。149 次只读资源采样最低 MemAvailable 759,224KiB、SwapFree 123,796KiB、tmpfs 可用 508,190,720 字节，原日志无 ENOSPC 或 OOM 诊断，runner 正常以 1 退出；不能据此解释全部失败。

原 SSH 控制连接中途被远端关闭（客户端 255），本次唯一原 runner 持续写日志；真实退出来自原 runner 保存的子进程结果，没有重启完整检查。回收原始包 `full-check-raw.tar.gz` 的 SHA-256 为 `3ba2c647bdb1fb6df0a1bdc7fa54908f909f7f414e4726b3b404d0c72aea26b6`，20 个原始成员全部回读核实；本归档保留这些完整成员并另加独立 foundation 日志。

本轮没有真实模型、真实 IM 或部署。原完整检查失败不能记通过；两项未明失败与后续夹具验证须读增量结果。远端目录在所有证据复制并核对前保留。
