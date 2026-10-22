# 合并 develop 的组合验证

2026-10-22，拥有者要求将 `Eitrous/desktop-settings` 合并到本地 `develop`。来源为 `397c1e5172c595aac5583977e5941a8a89646b57`，目标为 `ce7b66c3668f735c931ba00a9f791468f101adaa`，共同基点为 `271f83c71139df91129eee28a9364ec8f90ecc00`。两工作树开始时干净；在 `/Users/eitrous/Developer/ruukoto` 完成合并，来源分支保持不变，不推送。

## 冲突与组合修复

16 个文本冲突均保留双方意图：模型/MCP/Skills 设置与问题/后台 IPC 同时开放；桌面保留设置窗口、会话后台菜单和两类独立刷新代次；Personal 保留业务格式 2、后台/检索/托管技能目录及问题回执；控制函数同时接受设置请求和问题写入，保留设置专用超时。文档与检查导航合并，重复测试入口改为链接，未提高篇幅上限。

独立审查发现在线设置预检遗漏新待答问题及目录认领：真实 Harness 的提问/后台启动任务已终态时，在线返回空阻塞项，但离线保存拒绝，可能先停服务再无法保存。合并修复使在线同样检查待答问题和未释放目录，缺少问题引用时拒绝；在线/离线均检查新增问题与后台结束回执文件。原有错误分类与协议保持，决定同步到 Personal 设置笔记。

## 验证

环境为 macOS arm64、Node 24.15.0。日志保存在 `/tmp/ruukoto-desktop-settings-merge-*.log`。

| 检查 | 结果 |
| --- | --- |
| `npm run change-scope -- --base ce7b66c3` | 核实本次合并范围 |
| `npm run build` | 通过；预检修复后另执行 `npm run build --workspace=ruukoto`，最终个人包重建通过 |
| `npm run check:static` | 最终源码通过；文档冲突造成的篇幅与段落错误已修正 |
| 下列 29 文件交叉回归 | 首轮 508 项：505 通过、1 个 SSH 替身子进程 3 秒超时、2 个 Linux 专用用例跳过；日志 `tests.log` |
| `RUN_MODEL_CHECK=0 npx tsx --test test/desktop-personal-settings.test.ts` | 首次单文件复测另一个子进程 3 秒超时；待构建和静态任务结束后独立复测 20/20，未修改超时或断言，日志 `ssh-isolated.log` |
| `RUN_MODEL_CHECK=0 npx tsx --test test/personal-settings.test.ts test/personal-settings-blockers.test.ts` | 修复后 33/33；包含新增真实提问终态/取消、目录认领/释放、悬空问题及新增回执文件回归 |
| `npm run desktop:build`、`npm run desktop:mygo:build` | 均通过；两壳 `codesign --verify --deep --strict` 通过，保持 ad-hoc 签名 |

首轮命令：

```sh
RUN_MODEL_CHECK=0 npx tsx --test test/desktop-settings.test.ts test/desktop-settings-models.test.ts test/desktop-models-layout.test.ts test/desktop-settings-mcp.test.ts test/desktop-settings-mcp-backend.test.ts test/desktop-settings-skills.test.ts test/desktop-personal-settings.test.ts test/desktop-personal-settings-pages.test.ts test/desktop-mygo.test.ts test/38-desktop-main.test.ts test/38-desktop-personal.test.ts test/43-desktop-demo.test.ts test/desktop-composer.test.ts test/background-process-clients.test.ts test/owner-question-clients.test.ts test/31-model-config.test.ts test/33-config-tui.test.ts test/66-control-seam.test.ts test/personal-settings.test.ts test/personal-settings-blockers.test.ts test/personal-managed-skills.test.ts test/personal-maintenance.test.ts test/personal-cli.test.ts test/personal-durable.test.ts test/personal-background-processes.test.ts test/personal-file-search.test.ts test/personal-questions.test.ts test/managed-skills.test.ts test/managed-skills-reference.test.ts
```

独立上下文 `/root/merge_review` 直接核对双方代码与冲突解决，复现并复核上述预检缺口：真实 Harness 的待答问题、后台运行中/停止未核实均阻断，后台执行使用替身。另以真实 Coding Runtime、本地模型替身与实际后台进程核实托管技能停用后不进入新任务，旧参考快照字节保持。最终无未解决合并阻断。

## 未覆盖

未运行全量 `npm run check`、Linux 专用用例、真实模型/HTTPS MCP 或原生 GUI 体验；两个 Linux 跳过项分别为个人后台原 scope 与服务 sudo 接线。原 [09 验收记录](09-verification.md) 的产品体验与真实 HTTPS MCP 缺口继续保留，合并不等于产品验收完成。SSH 替身测试存在本机耗时敏感性，保留两次超时记录，不将单次复测成功描述为已修复测试稳定性。
