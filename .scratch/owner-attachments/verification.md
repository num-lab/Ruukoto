# Desktop 附件后台验收

2026-10-16，隔离工作树 `desktop-attachments`。真实 Runtime、ControlServer、SQLite、磁盘、SubmissionGuard 和本机模拟模型 HTTP；没有调用真实模型或操作 Electron 系统选择窗口。

## 检查

`npm run setup -- --skip-hooks` 完成隔离依赖安装。`npm run check:static` 通过；最终安全边界修正后又执行 `npm run lint`、`npx tsc --noEmit`、`git diff --check`。`npx tsx --test test/desktop-attachments.test.ts test/38-desktop-main.test.ts test/09-artifacts.test.ts test/66-control-seam.test.ts test/90-inbound-media.test.ts` 92/92 通过；后续 manifest 边界修正以新增附件 5/5 的复跑为准。`test/36-event-flow-state.test.ts`、`test/41-desktop-stream.test.ts`、`test/42-desktop-inspector.test.ts` 同批 34/34（包含当时附件前三条）通过；96／102 既有 18 条通过，另有独立复核 96 的 4/4 通过。

独立附件实现复核直接核对任务、产物与 task.attachments 的同事务绑定，额外验证实例不变时重构暂存类可续传、坏 manifest 身份拒绝，以及普通附件分支后的真实模型输入，未发现剩余阻断。临时重启／故障脚本不是正式产品入口。

## 模型可见内容

同一普通开发会话画像与 confirm 模式，真实模型请求及已落盘 prompt 快照均含用户附件引用与 `read_artifact` 指引。以原描述替换同一工具目录建立改前对照，其他装配不变：systemPrompt 1509 → 1509，toolSchemas 9360 → 9383。快照与实际请求核对了产物 ID、用户附件读取说明、最终工具描述；普通中文文件的后续工具结果含实际原文，图片请求含实际视觉 data URL，JSONL 只保留稳定引用，不含 base64。未对所有产品／会话画像重复快照矩阵。

## 未验证与限制

真实 Electron 选择器、macOS 权限交互和 renderer 附件草稿由总迁移验收覆盖。普通二进制提供 utf8／base64 字节读取，不自动解析 PDF、Office 等格式。未提交暂存当前不清理，磁盘会累积；不能删除未决提交可能引用的字节。协议版本由主迁移统一提升，当前隔离分支不单独提升。
