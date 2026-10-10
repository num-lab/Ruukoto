Status: resolved

# 把代码注释里的 ADR 编号改为 note 锚点

依赖：03。范围见 [spec](../spec.md)。

## 做法

- 范围：`src/`、`test/`、`verification/foundation/`、`verification/smoke/`、`deploy/`、`README.md` 里的「ADR 00xx」，约 40 处。**`verification/archive/` 不改。**
- 写法：从括号里删掉 ADR 编号，保留「agent-direction issue NN」等工单出处；在同一注释块里加一行 `Note: 见 .agents/notes/implemented/<class>/<file>.md`，路径从仓库根算起，`check-note-anchors.ts` 能识别。一个注释块引用多篇时，每篇各占一行。
- 「ADR 0012 修订段」「ADR 0020 补充」这类引用，指向工单 03 里实际承载这段内容的 note（可能是拆出篇）。
- `docs/runtime.md` 和 `CONTEXT.md` 里的引用不在本单处理，由 06、07 处理。

## 验收

- [x] `git grep -nE "ADR ?0[0-9]{3}" -- src test verification/foundation verification/smoke deploy README.md` 无命中。
- [x] `npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts` 报告的锚点全部指向存在的 note，报告摘要记在 Comments。
- [x] `npm run check:static` 通过，产品代码 diff 只涉及注释，另有拥有者确认的 CLI 帮助文案例外，见 Comments。

## Comments

2026-10-10：完成 49 个文件中 67 处旧 ADR 匹配行的迁移，保留工单出处，加入 80 行独立 Note 锚点，指向 25 篇 implemented note。README 使用具名链接；多篇引用各占一行。0012 的启动停用修订指向 QQ 私聊母篇；0020 的复用、取消、消息、恢复补充分别指向拆出篇；长期授权指向 standing-permissions；0014 指向核心群聊退役替代篇。

范围例外：`src/cli.ts` 的 `defaultHelp()` 帮助字符串含旧编号，与“grep 无命中”和“只改注释”两项要求冲突。拥有者在本轮明确选择删除帮助文案中的旧编号、在函数注释加入 note 锚点，并在工单记录例外。实际只删除该句中的编号括注，CLI 命令与运行逻辑不变。`src/core/db.ts` 的两组 SQL 注释改为块注释，以便锚点脚本识别；有效 SQL、schema 与迁移逻辑不变。

锚点报告：`anchors found: 71 across 25 note(s)`，`[dangling anchors] none`，未指向 note 路径的锚点为 0；`[implemented notes without any code anchor] 9 of 34`。这 9 篇不在旧 ADR 引用迁移覆盖的入口中，本单未扩充锚点。脚本不扫描 `.md`、`.service`、Dockerfile 与 `.mts`，其中另有 9 条新锚点；补充路径断言和独立复核覆盖全部 80 条锚点，目标全部存在。

验证：验收 grep 无命中（退出 1），`git diff --check` 通过，`npm run check:static` 通过；`npx tsx --test test/29-cli-entry.test.ts test/71-product-entry.test.ts` 为 28/28 通过；真实 CLI 帮助输出断言确认产品说明保留、旧编号已删除。完整 `npm run check` 通过：应用 1020 通过、1 跳过，基础验证 9 通过、1 跳过，失败均为 0；跳过项为默认关闭的真实模型检查。

独立差异复核：45 个 JS/TS/MTS 文件的 AST 去注释后与 HEAD 对照，SQL 模板另剥除 SQL 注释核对有效内容，仅有上述已确认的帮助文案变化。部署配置的有效内容不变；`verification/archive/`、`docs/runtime.md` 与 `CONTEXT.md` 无改动。未运行 Docker、真实 IM 或真实模型验收。
