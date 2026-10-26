# Personal 基点失败核验

基点为 `85d007b92a9a8e852d7a9727574b9a278f7838da`，执行目录为 `/Users/eitrous/.codex/worktrees/pi-mcp-clients/ruukoto`，该副本 Pi AI 仍为 0.85.1。被验 Personal harness/control/settings-records/service-inspection/service-helper、两份测试与 fake-service-helper 均对 HEAD 无 diff；客户端副本内其他改动不涉及这些文件。

原命令为 `npx tsx --test --test-name-pattern='认证socket|工具取消仍保存停止证据' test/personal-background-processes.test.ts test/personal-services.test.ts`。基点与迁移后的主工作区均为认证 socket 测试稳定失败 `settings_history_invalid`、服务取消窄跑通过；原工单前轮 17:16 已有同一认证 socket 失败。用例在首次开启档案后裸写配置文件，未使用配置发布历史，安全门拒绝该不一致。

服务取消的 calls.log 在 helper 建立检查 claim 前写入。临时目录将 mkdir 到 claim 写入间延迟 200 ms 后，基点旧用例稳定复现原 `1 !== 0`；将等待条件推迟到 claim 文件存在，注入反例通过。该改动仅用于证明竞态，没有写入仓库，也不是正式修复；若修测试，应等待完整 claim 或 helper 完成标记，避免只检查文件存在留下部分写入窗口。

复跑竞态：`python3 ruukoto-pi-mcp-personal-claim-reproduce.py --repo /path/to/baseline-checkout --logs /tmp/personal-claim-proof`。脚本只读源码与现有 node_modules，创建并自动清理临时测试/假 helper，不修改检出。

这些均为离线夹具；未触达真实服务、IM、生产档案或真实桌面。
