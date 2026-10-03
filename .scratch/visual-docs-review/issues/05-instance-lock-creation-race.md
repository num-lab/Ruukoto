Status: ready-for-agent

# 05 — 实例锁在建目录与写 owner.json 之间可被另一进程接管

**What to fix:** 两个后台几乎同时启动时，只能有一个取得实例锁（以及配置锁），不能因为对方还没写完 `owner.json` 就把它的锁当成遗留锁接管。

## 现状与证据

`src/core/instance-lock.ts` 的 `acquireLock` 流程：

1. `mkdirSync(lockDir)`：成功即视为自己创建了锁。
2. 失败且错误为 EEXIST 时调用 `readOwner(lockDir)`：
   - 读到存活且像后台的进程，报冲突；
   - 进程已退出、PID 被无关进程复用，或者 **`owner.json` 缺失或损坏**，都走 `takeover()`：先 `rmSync` 整个目录，再 `mkdirSync`。
3. 最后写 `owner.json`。

竞争窗口：进程 A 完成第 1 步、还没走到第 3 步时，进程 B 在第 2 步读不到 `owner.json`，于是删掉 A 的锁目录并重建。随后 A 和 B 都写入 `owner.json`，各自认为持有锁。配置锁用的是同一个函数，存在同样的窗口。

- 窗口只有微秒级，但 agent-direction 工单 02 明确要支持「两个终端同时打开 ruukoto-dev，收敛为单实例」，按需拉起正好会触发并发启动。
- 工单 02 的 R10 修复把「`owner.json` 缺失 / 损坏」定为可接管的遗留锁，没有区分「对方正在创建」的情况。

来源：2026-10-03 可视化文档核查（deployment.html）；主代理按代码复核。

## 验收标准

- [ ] 锁的创建是原子的：先在临时目录写好 `owner.json`，再用 `renameSync` 把整个目录改名成 `lockDir`（目标已存在时改名失败）。或者采用其他能保证「锁目录存在即带有效 `owner.json`」的做法。
- [ ] 保留现有语义：真正遗留的锁（进程已退出、PID 被复用）可以接管；无法核实持锁身份时报 unverifiable、不接管；确认是存活后台时报冲突，退出码 42 的行为不变。
- [ ] 处理旧版本留下的、没有 `owner.json` 的锁目录。例如按目录修改时间加宽限期判断，或在工单里写明为什么可以直接接管。
- [ ] 测试：并发启动多个获取同一把锁的进程（或在第 1、3 步之间注入延迟），断言只有一个成功；补齐现有的遗留锁、复用 PID、unverifiable 三类用例。
- [ ] 同步 `docs/visual/deployment.html`（进程拓扑、按需拉起的并发说明）与 control-protocol.html「建连之前」里关于锁竞争的说法。
