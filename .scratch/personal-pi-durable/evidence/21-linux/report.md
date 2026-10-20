# 本轮 Linux 独立验证

Status: 定向验证通过，本次远端目录已清理

环境：Linux 6.8.0-117-generic / x86_64，执行账户 uid 1003，Node 24.21.0、npm 11.19.0；模型和 Telegram 均为离线替身，Linux HTTP 场景使用实际 Unix socket 与生产 sudo 路由的专用命令桩，不证明真实 systemd、平台或模型通过。

初始同步 1394 文件，tar SHA-256 `4c7aac3e634dc9679f09db34bd40fcc5e4e0653424c100d1076898d61424758a`。排除 .git、node_modules、dist、.cache 与 .scratch 下 evidence；包含 tracked 与 untracked 当前文件。首轮稳定增量变更 20 文件、删除 1 个被移入 implemented 的 proposed 笔记，随后补齐两处最终测试修正，最后只补 CLI 等待原审批 Task 结束的同步。每轮 1394 文件均与记录的对应 manifest 哈希一致；首轮与最终快照分别保存在 tested-manifest-first-pass.json 和 tested-manifest.json，增量由各 increment 文件持有。

| 检查 | 结果 |
| --- | --- |
| `npm run setup -- --skip-hooks` | exit 0，149 秒；只在独立副本 git init，不安装 hooks |
| `npm run build` | exit 0，1.897 秒 |
| pre-push 的 12 个个人测试文件 | 394/394，0 跳过，72.889 秒 |
| `npx tsx --test test/71-product-entry.test.ts` | 17/17，0 跳过，31.912 秒 |
| CLI 最后测试等待增量后整文件 | 26/26，0 跳过，13.914 秒 |

个人 12 文件与产品入口共 411 个唯一通过场景，最终 CLI 26 个为重复覆盖、不叠加计数。新增 Linux HTTP 场景在首轮和最终 CLI 整文件均通过；没有测试失败、重试或跳过。最后仅修正测试等待顺序，生产代码未变；保留两轮原始日志，不覆盖首轮结果。全部命令、起止时间与退出码见 steps.jsonl，setup 起止记录在 logs，精确执行器在 commands。

源码/依赖位于本次 `/dev/shm/rk-linux-deps.H6A9ny4b/repo`，本次入口和 TMPDIR 位于 `/tmp/rk-linux-verify.CohhCfz7`。根盘初始仅余 615 MiB，tmpfs 余约 1.8 GiB；setup 后仅删本次 npm-cache/_cacache 216 MiB，为构建腾出空间，没有清理共享缓存或其他目录。

清理前后按本次路径比较可读的同账户进程 cmdline/environ/cwd/exe，只记录匹配结论和 PID/PPID/comm，不输出或保存 argv/environment 字节；本次探针祖先与基线已经存在但不可读的进程排除。未发现本次路径的存活进程、未发现新增僵尸、全部检查进程 PID 已退出；7 条基线 MainThread/esbuild 的 PID/PPID/comm 不变，未向任何进程发信号。已删除本次 tmpfs 和 /tmp 根目录，cleanup-verified.json 确认两根路径均不存在；本地保留日志与证明供父 agent 入库。

未跑全量 check、Linux 静态门禁、真实模型、真实 IM、真实 systemd 或正式部署；隔离测试不代替这些证据。
