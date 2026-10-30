# 追加说明独立实现审查

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../../git-history-cleanup/archive.md)。

审查对象：基点 `06488645e1d50ed48e50230459c484cc0b2ac17f` 后本轮运行时代码、工单 12、规格、决定及相关测试；独立只读上下文 `notes_review`，macOS / Node 24.15.0。当前结论：无未解决实现阻断。

## 依据

- 直接核对 Pi 1.3.0 `admitSubmission` 的原键复接、`Submission.abort` 与 `Conversation.abort` 的范围；确认恢复从最后已有原生 Submission 的轮次开始，收尾重新读原工作追加列表，取消与释放占用维持原 Task。
- 亲跑 `npx tsx --test test/personal-work-notes.test.ts test/personal-work-controls.test.ts test/personal-service-operations.test.ts`：72/72，零失败、零跳过，约 11.69 秒；日志 `ruukoto-notes-review-tests.log`。覆盖四个真实强杀窗口、CLI 应答丢失后原键查询、TG 去重/来源及新追加来源效果未知屏障。
- 精确 stop 两窗口当前代码额外亲跑 3/3；在独立 `/tmp` 副本仅撤去最终事务新说明判断，两个子窗口均以 `1 !== 2` 失败，证明用例会捕获已接纳说明被丢弃的回归。负例是预期失败，见 `baseline-stop-test.log`、`ignore-new-notes-test.log.gz` 与 `ignore-new-notes.diff`。
- 独立 SQLite 探针确认首次追加恰落一条；将追加来源改为无关 list 工具，或删除保留键对应的模型 Task，均在验证时抛 `work_note_invalid`。见 `ruukoto-notes-review-probe.mjs` 和同名 log。
- 用 HEAD 旧 control 路由启动独立后台，当前 CLI 对工作追加使用独立 `/work/notes`：POST 与 GET 均 `control_route_missing`，pending 文件保留一份，主聊天未出现追加正文。旧路由仅 imports 指向当前运行依赖，隔离验证协议误投；未声称旧完整二进制部署验收。见 `old-control.mts`、`ruukoto-old-server-note-probe.mjs` 和同名 log。
- 审查中发现并返修的缺陷均已关闭：首次 document proxy 赋值后 push 丢失、模型来源恢复降级、已运行旧后台把说明当主聊天、新追加来源未知服务效果可借原安全工作继续。已重跑相关反例。

## 重放与快照

两个 `.mjs` 探针从仓库根执行 `node --import tsx --input-type=module < <脚本路径>`；`review.py` 创建新的独立副本并执行最终事务负例。`snapshot/` 留存突变后的代码与所需测试，依赖用只读符号链接复用当前安装；复制证据时可只复制本目录顶层日志、脚本、JSON、Markdown 与 diff。

`source-before.json` / `source-after.json` 记录 app 全部 TypeScript 文件及三份受测文件 SHA-256；突变试验前后工作区输入相同。`summary.json` 保存命令、返回值、环境与基点。全部修改仅在审查临时目录，工作区由主实施者唯一写入。

## 未覆盖

未独立重跑全量静态/构建、Linux、真实模型、真实 Telegram 或人工产品体验；根与另一独立上下文分别承担已安排检查。整项委托归属、自动最终回报、QQ、外部工具权限与正式切换保持后续工单边界，不能据本审查宣称迁移完成。
