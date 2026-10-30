# 内置 read 读取图片

Status: resolved

## 目标与边界

拥有者于 2026-10-12 明确要求「让内置read支持图像读取」。内置 `read` 在普通与只读 SubAgent 路径都应将 JPEG、PNG、WebP 交给视觉模型，文本读取与原始字节产物捕获保持原有语义；图片探测与读取均受现有执行边界和只读范围约束。复用现有 `imageMime` 与已安装 pi 的图片处理和缩放，不增加依赖、OCR、工具名或配置入口。不支持图片输入的模型沿既有 `image_input_unsupported` 发送前检查拒绝请求。

## 方案

这是可观察能力与受限读取相关的修复，按开发流程重路径推进。根因是 `packages/agent/src/tool-worker/worker.ts` 的两套 `ReadOperations` 都漏掉 `detectImageMimeType`。每次 `read` 新建适配器，由原 reader 读取并捕获一次原始 Buffer，探测复用 `imageMime`，上游读取返回同一 Buffer 并处理图片。这样保留受限路径的范围核实、符号链接拒绝与 `O_NOFOLLOW`，也不会重复捕获字节。含 `opId` 的超限结果帧改为返回该操作的小型错误 result，没有 `opId` 的超限消息继续 fatal；保持 4 MiB 整帧上限，原始捕获可定稿，后续读取可继续。

影响范围是 worker 两套读取适配器、`packages/agent/src/tool-router.ts` 的模型可见说明、`test/07-read-images.test.ts` 的真实工具回归，以及对应 execution／agent-tools 模块文档和决策笔记。测试证明普通与受限图片读取产生 image 块，原始产物没有重复捕获，文本不回归，范围外图片和符号链接仍被拒绝，图片进入实际模拟模型 HTTP 请求并能从会话记录重建。运行 worker 构建、定向测试与 `npm run check:static`，不跑全量 check。

## 进展与交接

- 当前角色：实施者；实现、模块文档与[决策笔记](../../../.agents/notes/implemented/bug-fix/2026-10-12-read-images.md)已完成，工程验收通过；拥有者已授权提交。
- 基点与审查时 HEAD：develop，`885dff689a8111ee99f48620762629a189aa48ea`；本次改动是 worker、tool-router、artifacts 的说明、两个模块文档、本工单、决策笔记与新增图片回归；被审内容见 `evidence/implementation.patch.gz`。
- 下一动作：交付已验收的实现、文档与证据；本任务没有未完成的实现或审查，未部署。
- 阻塞：无拥有者待决项；实现方法按审查结果调整，不改变目标与权限边界。

## 验收与证据

工程验收通过。2026-10-12 独立方案审查者 `/root/read_images_review` 直接核对 worker、上游公开接口、传输与会话记录后确认方案通过，无剩余阻断；审查对象为本工单的最终接法与 HEAD 源码。该审查者在独立执行上下文核对[实现快照](../../git-history-cleanup/archive.md?path=.scratch%2Fread-images%2Fevidence%2Fimplementation.patch.gz)与实际工作区的 8 个文件，亲自执行新增图片回归 6/6、`git diff --check` 和快照哈希核对 8/8，通过实现审查且无阻断。审查后只同步本工单的验收事实，未改实现、测试或契约；快照无损压缩存放，解压后的内容与审查时相同。

| 验收要求 | 实际证据 |
| --- | --- |
| 普通、工作区只读与额外资料根均读取 JPEG、PNG、WebP；原始字节只捕获一次，文本不回归 | 作者与独立审查者分别执行 `npx tsx --test test/07-read-images.test.ts`，均为 6/6 通过、0 跳过 |
| 范围外图片和符号链接拒绝，整帧超限只失败当前操作且后续读取可继续 | 同一新增回归，真实 local worker；不把 local 结果视为 OS 沙箱证明 |
| 实际模型 HTTP 请求含图像，JSONL／prompt 快照可重建，仅文本模型发图前失败，原始产物定稿 | 同一新增回归，真实 Runtime／SQLite／worker 与模拟 HTTP 模型 |
| 既有工具、审批、访问模式、账本、SubAgent 与 IM 图片输入不回归 | 作者执行 `npx tsx --test test/07-real-tools.test.ts test/08-approvals.test.ts test/10-access-modes.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts test/80-subagent-delegation.test.ts test/96-vision-driver.test.ts`，81/81 通过、0 跳过；[完整日志](../../git-history-cleanup/archive.md?path=.scratch%2Fread-images%2Fevidence%2Fregressions.log) |
| 构建与静态规范 | `npm run build:worker`、`npm run check:static`、`git diff --check` 通过；[静态日志](../../git-history-cleanup/archive.md?path=.scratch%2Fread-images%2Fevidence%2Fstatic.log) |
| 正式原生入口可处理图片 | 作者在 macOS、Node 24.15.0 用 native／confirm、空 readRoots 与钉定工作区身份读取无扩展名 PNG，结果图像与原始字节一致，停止已核实；[结果](../evidence/native-read.json) |

产品验收不适用：本任务没有主观体验取舍。没有执行全量 check、Linux native、Node 22、真实视觉模型或真实 IM；模拟 HTTP 证明传输与记录，不证明真实识图效果。正在运行的后台需重新加载改动后的宿主代码，worker 已构建。

上一轮诊断已确认：同样的自定义读取操作将 PNG 作为 text 返回；`test/96-vision-driver.test.ts` 4/4 通过，证明既有图片输入与仅文本模型拒绝路径可复用。这不是本次修复的验收证据。

## Comments

2026-10-12：拥有者在诊断后授权完成内置 read 的图片读取。

2026-10-12：独立方案审查拒绝直接在受限路径调用上游 FromFile helper，因为其 `open(path, "r")` 会在校验与打开之间跟随替换后的最终符号链接；采用同一受限 Buffer 的探测。确认上游 4.5 MiB 是 base64 上限，不能等同于本项目 4 MiB JSON 整帧上限。

2026-10-12：独立实现审查通过，相关回归 81/81、新增读图 6/6、静态门禁与 macOS native 读图通过；工程验收完成。

2026-10-12：拥有者要求提交本次改动。
