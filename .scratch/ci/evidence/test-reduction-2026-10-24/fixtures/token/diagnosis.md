# 个人入口令牌半发布与测试清理遗留

## 原始现场

最终 macOS 全量中的 personal-entry PID32861 在7条测试均结束后仍不退出；残留 serve33599 与 mock listener53911。serve档案为 `/private/tmp/r38-dVCBMp`，profile/model/token/owner文件已被删除，但serve仍持有旧owner inode并监听socket。无认证GET /status正常返回control_unauthorized，说明恢复已完成。现场没有认证token，未绕过认证或启用Inspector，也未输出环境和凭据。

root授权按精确出生身份回收本次serve、测试父与esbuild后，原runner输出定位第5条“serve启动中的关闭意图及真实SIGTERM/SIGHUP…”：ready()读取启动中的control.token，得到control_token_invalid。其余6条通过。原完整check属于人工诊断回收，不能计为通过。现场与身份清理证据在 `/tmp/ruukoto-personal-entry-hang-32861/`。

## 两个机制

产品直接writeFileSync创建或截断control.token，跨进程轮询能在写入完成前读到空文件。应完整写入同目录0600临时文件后rename发布。个人配置已有相同临时文件模式；仓库唯一名为atomicWrite的函数是agent/model-config私有实现，不能直接复用而不增加不合适依赖。候选 `token-atomic.patch` 仅替换写入与增加profile临时普通文件白名单；旧无效token校验仍先于写入。

测试先注册目录rm、再注册mock.close、最后注册child关闭，而Node24 after hooks按注册顺序执行，某项失败跳过余下hooks。原现场与目录清理失败后遗留子进程、mock的形态相符；具体被原body错误遮住的after错误未直接取到。候选 `entry-cleanup.patch` 只在本文件收集三个清理阶段，按child→model→directory执行且捕获每项失败后继续，最后汇总错误，无共享框架或产品停止规则改动。

## 受控证据

`token-results.json`：6项真实独立进程启动对照，强制停在创建/截断后而内容未写入。原版初次启动与重启均读到control_token_invalid；原子版初次读到control_unavailable、重启读到完整旧token，发布后新token有效、0600、GET /status正常，旧坏token未被覆盖，残留普通tmp可恢复。

`token-failure-results.json`：4项故障边界。临时写入失败与rename失败保留完整旧token并释放档案锁；tmp目录与符号链接被拒绝，旧token及链接目标字节保持。检查锁释放时仅删除探针主动构造的无效临时对象。

`cleanup-results.json`：同样强制目录清理失败，原版先rm并跳过child/model清理，进程不退出；候选先关闭child和model，再执行rm并自然退出1。`cleanup-fixed-multi-failure.events.jsonl` 额外注入最早child清理项失败和model清理项失败，剩余child、model、directory仍全执行。所有9个有记录的子进程最终均核实identity=0，见probe-process-cleanup.json。

## 永久回归建议

`entry-token-regression.patch` 直接扩展现有entry第5条，不增加测试数量：子进程将控制文件写入停在创建后，父读取必须只报尚不可用，然后finally释放写入，继续原启动关闭意图与真实SIGTERM/SIGHUP验证。旧直接发布代码确定失败，原子版通过：entry-regression-red.log与entry-regression-green.log。绿例主体5.091秒，整体7.863秒。

`cli-token-failure-regression.patch` 扩展现有“坏配置、坏令牌、链接文件…”一例，不增加测试数量：覆盖写入/rename失败、旧token保留与释放锁，tmp目录/链接拒绝，残留tmp恢复与0600。临时副本通过，主体0.310秒，见cli-failure-regression-green.log。

所有候选与控制实验均只位于/tmp，主仓由root单一写入。没有运行真实模型或OS worker。
