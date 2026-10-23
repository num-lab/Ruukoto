# 拥有者浏览验证

日期：2026-10-24。环境：macOS arm64、Node 24.15.0。基点：`902eeac59d58c2c9728cd217b8f2fb6a91c83fdb`，验证当前未提交改动；源码清单与 SHA-256 见 `source-hashes.json`。不包含同工作树的其他 CI／测试策略改动。

## 行为与检查

- 修改前运行 `npx tsx --test --test-name-pattern='拥有者.*不受 Agent 保护目录限制' test/desktop-workspace-files.test.ts test/desktop-workspace-git.test.ts`：2 项失败，分别为 `workspace_path_unsafe` 与 `workspace_git_unsafe`，证明原查询拒绝拥有者浏览。
- 修改后运行 `npx tsx --test test/desktop-workspace-files.test.ts test/desktop-workspace-git.test.ts test/desktop-live-files.test.ts test/dir-identity.test.ts test/desktop-inspector-tools.test.ts test/protected-path-batch.test.ts test/10-access-modes.test.ts`：125 项中 124 通过，1 项因调用迁移时误删 worktree 夹具声明失败；恢复声明后完整复跑 `test/desktop-workspace-git.test.ts`，17 项全通过。七文件的最终 125 项均已有通过证据，零跳过。
- `npm run check:static`：首次在同一夹具缺失处报类型错误；修复后完整命令通过，覆盖 lint、所有 workspace 与 foundation 类型检查、笔记和文档门禁。
- 拥有者控制面回归覆盖目录、文件与 Git 在保护根包含登记根时仍成功；枚举真实无关保护树会触发断言。原路径、链接、目录身份、文件版本、Git 分页和修订变化用例保留；Agent 的目录授予与批量物理保护仍拒绝原范围。
- 独立审查者 `owner_browsing_review` 亲验 13 项浏览、路径、竞态、分页、身份及 Agent 保护回归全部通过；在三个临时进程分别向 Runtime 的目录、文件、Git 入口恢复保护拒绝条件，对应控制面用例均以拒绝错误失败，确认每条查询的回归独立有效。实现审查无阻断。

## 性能

目标文件由拥有者指定，为 `/Users/eitrous/Developer/Temp/ieee754.html`，25,901 字节、535 行。读取正文仅用于完整性比对，不保存正文。

| 操作 | 修改前 | 修改后 |
| --- | --- | --- |
| Temp 目录查询 | 419–452 ms | 0.335–2.060 ms |
| HTML 单页读取 | 1580–2137 ms | 0.477–0.922 ms |
| Temp 非 Git 仓库检测 | 196–227 ms | 0.180–0.547 ms |
| 同时发出的轻量查询 | 1612 ms | 0.593 ms |
| 单提交 Git 仓库 | 551–707 ms | 27–47 ms |

修改前文件与目录数据来自当时运行的日常后台，经真实控制 socket；单提交 Git 数据来自独立进程直接调用同一 Runtime 查询函数。修改后全部通过临时 Runtime 与真实控制 socket，启动和工作区登记不计时；目标 HTML 内容逐次逐字节比对，小仓库断言返回一条提交，模型调用数断言为零。前后进程环境和负载不是严格相同，数字用于确认秒级保护扫描退出，不作为固定延迟承诺。

重跑：`npx tsx .scratch/desktop-file-tree/evidence/2026-10-24-owner-browsing/measure.mts /path/to/file.html`。原始数据为 `before-live.jsonl`、`before-git.jsonl`、`after-control.jsonl`。

## 未覆盖项

未重启日常后台、未改其档案，当前运行进程须重启后才加载修改。未进行原生 MyGo／Electron UI 绘制验收、Linux 实机或大型 Git 仓库基准。此次删除浏览专用扫描，没有新增平台原语；原生 UI 与 Agent 执行限制不变。
