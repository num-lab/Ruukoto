# macOS 进程边界夹具就绪竞态与早退清理

## 现场结论

2026-10-24 最后一轮完整 macOS check 卡在 `native-macos-identity.test.ts` 的 `ordinary-double-fork`。wrapper supervisor 22168 已退出；worker 22169 与 orphan 22171 持有原 Node ChildProcess 的 fd3/fd4，导致 `close` 不触发，JS `finally` 无法发布 release。当前夹具是 `/private/tmp/rk-macos-identity-ocNFrB`，与 2026-10-23 的另一组 scope 遗留无关。

现场先保存 ps、lsof、源文件、文件时间、supervisor journal。按 root 授权，重新核实 22169/22171 的精确 executable、出生秒、uniqueid、pidversion 后发布当前 fixture 的 release。确认 orphan finished，才按完整出生身份与 audit token 向当前 worker 发 TERM；两者均核实已退出。清理前后的身份与信号结果保存在 `/tmp/ruukoto-macos-identity-hang-21938/`，未触碰其他 scope。

清理后 root 从原 check 日志确认 supervisor 实际退出值为 4；原完整 check 自然失败，不计通过。原进程没有开放 Inspector，未发送 Inspector 信号或占用调试端口。

## 机制与控制对照

夹具 orphan 用 `open(O_CREAT|O_EXCL)` 发布文件名，再 `dprintf` 写入 PID；supervisor 仅等文件存在，可能在写入前读到空内容而 return 4。该早退跳过 release 与 worker 回收；worker 永久 pause，orphan 等待 release，两者继承额外管道。

复制现场 scope.c 到隔离目录，仅在 open 与 dprintf 之间加入 250ms 停顿：原版稳定 exit 4，exit 之后 400ms 仍无 close。临时文件写入并 close 后 rename 发布：exit 0，close 正常，原 stopped.reaped=true 与 orphan.alive=false 断言均保持。证据为 `../ruukoto-macos-identity-hang-21938/ready-publication-results.json` 与控制脚本。

## 最小修复

`fixture-fix.patch` 仅修改本测试生成的 C 夹具。就绪 PID 通过临时文件完整写入后 rename 发布；fork 后 return 3/4/5/8 统一跳转 cleanup，保留原错误码，发布 release 并 waitpid 本夹具 worker。root 与 go/group/joined 等待都响应 release，使早期失败也能归还继承管道。停止证明、未知孤儿判断与全部原断言仍在释放之前完成；未修改生产监督器、停止规则、重试或超时。

## 验证

临时测试副本运行全部五个原场景：6/6 通过（含父项），9.313 秒，见 green.log。对五个 mode 逐一注入 return 3/4/5，并对两个 known mode 注入 return 8，共 17 个受控失败，全部保留对应失败码、发布 release，ChildProcess close 均在 0.35–0.58 秒内完成；见 early-exit-results.json、early-exit.log、early-exit-probe.mjs。导出生成 C 文件的 export-wrappers.test.mts 仅用于构造控制实验，导出步骤不记为验收。

关键输出、清理身份与失败路径结果已归档在本目录。控制脚本与导出的 C 文件仍在上述 `/tmp` 原目录；原生成器由 `28c033f7:test/native-macos-identity.test.ts` 恢复，再按本文指定的 open 后停顿或错误分支注入重建。
