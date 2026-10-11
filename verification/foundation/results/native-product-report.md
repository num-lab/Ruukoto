# 工单 26：原生产品接入验收

2026-10-11，在 macOS 27 / Darwin 27.0.0 arm64 和 tx 的 Ubuntu 24.04 / Linux 6.8.0-117 x64 验证。模型为本地桩，worker、文件、进程、网络拒绝、控制面、Git 和 SQLite 均实际执行；未调用真实模型或真实 IM。

## 产品流程

| 检查 | macOS | Linux |
| --- | --- | --- |
| `npx tsx verification/smoke/smoke-26-native-worker.mts` | [10/10](native-macos-worker-report.json) | [10/10](native-linux-worker-report.json) |
| `npx tsx verification/smoke/smoke-26-native-worktrees.mts` | [8/8，停止与清理核实](native-macos-worktrees-report.json) | [8/8，停止与清理核实](native-linux-worktrees-report.json) |

worker 检查包含实际四工具、Node/Git/Python/C 编译、未授权文件及网络拒绝、独立临时资料、启动窗口取消、后台心跳停止、活跃工作区和授予身份替换拒绝、硬链接及物理别名检查。正式按需后台不传 execution 参数或环境覆盖，Docker 路径固定不可用，握手显示默认 native；完成任务后核实后台 PID、socket、锁与 SQLite 占用退出。

副本检查包含主任务修前失败/修后通过、限定文件的只读 SubAgent、两个并行修改副本、共享 Git 拒写、汇总到父工作区待提交区、HEAD 与各方成果保留，以及全部占用释放。

## 平台边界与反例

- [Linux 当前边界](native-linux-current-report.md)：52 项边界与 2 项有效宿主对照；[真实 scope](native-linux-scope-report.json) 3/3。未观察到可信 cgroup 时停止返回未核实。
- macOS 的 [88 项回执恢复报告](native-macos-stage1-88-recovered-report.md)来自[原始日志](native-macos-stage1-88-run.txt)，没有补填原日志未记录的元数据；[后续 90 项报告](native-macos-stage1-report.md)保留未知孤儿导致的真实失败，不能读作 90/90。
- 预存硬链接的 [macOS](native-macos-preexisting-hardlink-report.md)、[Linux](native-linux-preexisting-hardlink-report.md)及 [Data 别名计数](native-macos-hardlink-alias-initial-report.md)反例均原样保留。产品输入和每调用前按真实目录条目、文件身份及权限核实；修复后的实际拒绝见上述 worker 报告。
- [两次 worker 保守拒绝](native-macos-worker-census-failure.txt)与[临时目录复跑拒绝](native-macos-worker-tmp-census-failure.txt)原样保留，虚拟现场未自动删除。PID 1 的跨 UID 查询改为 flavor 17 后，真实 helper 5/5、最终 worker 与副本流程均通过。身份不明、观察中断及已观察到的版本回卷仍返回未核实。

## 回归与交付检查

- 产品入口 71/72/73：40/40；开发入口 32：27/27。正式 local/container 参数与环境覆盖被拒，个人产品原选择保留。
- 最终 08/10/100/101/101-scope：64/64；macOS helper：5/5。工具、审批、Plan、SubAgent、汇总与恢复的定向回归另按工单记录，不计为 OS 探针。
- 真实容器 smoke-04：6/6；升级 smoke-24 从协议相同的 `5e84daa` 基点：4/4，另一个产品运行与旧历史保留。旧协议基点 `60fa19e` 被前置检查拒绝，退出 2。
- `npm run build`、`npm run check:static`、`npm run test:foundation` 和笔记锚点检查通过；foundation 的真实模型项跳过。图解源码锚点、链接与文字布局已核对。

Linux 已按拥有者授权安装 bubblewrap 并加载仓库 AppArmor profile，整机 userns 加固仍为 1，未更改在线个人 Agent。安装与移除见[部署前置](../../../deploy/native/README.md)。

## 限制

macOS 只核实进程组与累计寿命集合，无法核实的后代仍可能改写已授权工作区或消耗资源；必须保留占用和现场，不能建立替代单元。授权树扫描不是宿主并发修改的原子快照，宿主属于可信方。未验证其他系统版本、Linux arm64 的真实 OS 边界、真实模型或完整完全访问部署；专用身份的路由与缺入口拒绝已回归，不把它们写成部署验收。
