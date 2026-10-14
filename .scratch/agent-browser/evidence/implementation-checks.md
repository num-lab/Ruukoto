# agent-browser 实现检查与恢复入口

2026-10-14，起点 `9e050ec`；以下记录实现阶段已执行的检查，提交合并与当前验收状态以[工单](../issues/01-integrate-agent-browser.md)为准。真实浏览器与模拟模型明确分开；[阶段 0 生命周期](lifecycle-probe.md)、[实现审查](implementation-review.md)和下列定向结果各自证明对应层。

## 已执行检查

| 检查 | 环境与结果 |
| --- | --- |
| `npm run build` | macOS Node 24.15.0，通过，生成 native/worker/script 与双产品包 |
| `npm run check:static` | lint、完整 typecheck、notes、docs 通过；后续文档与回归补充再复核受影响部分 |
| `test/browser-lifecycle.test.ts`、`test/browser-tools.test.ts`、`test/101-instance-lock.test.ts`、`test/29-cli-entry.test.ts` | Node 22.19.0：55 通过；另 `test/browser-model-acceptance.test.ts` 2 跳过、0 真实模型通过 |
| 浏览器正式回归 | Node 24.15.0：管理器 15、工具链 22；引用 eN/@eN 兼容补充又经独立 22/22 与边界 4/4 复核；涵盖保存失败的真实 HTTP POST 单次计数、取消/慢流总期限、保存失败仍停止真实单位、人工暂停后输入屏障及 IM 原消息顺序 |
| 相关既有回归 | 实际命令选 01/03/04/05、07-real-tools/07-read-images、08/09/10、14、62/63/64/66、94、101、111；189 项中 188 通过，TUI 工作流定义保存因当时 script worker 未构建失败；`npm run build` 后单独重跑该项通过。不是同一条命令 189/189 绿色，不把失败记录删除 |
| 双产品完整文件导出 | Node 22/24 的正式 bin 和真实 ControlServer：大 PNG 完整、哈希/权限、切片、元数据变更、截断、损坏与目标保留；[独立审查](export-independent-review.json) |

## 真实程序与组合

[Mac Node 22](manager-macos-node22.json)、[Mac Node 24](manager-macos-node24.json)、[Linux Node 24.21](manager-linux-node24.json)：实际管理器 8 项探针通过，包含三类子进程身份、控制变量移除、跨进程 UUID/localhost 别名排他、flag 文本、实际截图、Cookie 请求头复开、取消仅一次、SIGKILL 冷恢复，以及附接关闭保留用户 Chrome。Linux 使用临时库、shm 和显式 noSandbox 校准，生产前提仍欠缺。

[相对路径固定](manager-relative-paths.json)实跑构造器固定 binary/Chrome 后的不同 cwd 调用；[双产品 Runtime/SDK](runtime-sdk-macos-node24.json)使用真实浏览器与脚本化 mock 模型，ruukoto main / ruukoto-code dev 实际执行 open→snapshot→fill→click→screenshot，POST 各为 1、PNG/JSONL/provider 请求/prompt 快照哈希同源，第二轮保持 generation、Chrome PID 与 daemon 身份。这是组合工程证据，不是真实视觉模型辨图。

```bash
RUUKOTO_BROWSER_BINARY=/absolute/native RUUKOTO_BROWSER_CHROME=/absolute/chrome npx tsx .scratch/agent-browser/probes/manager-acceptance.ts
RUUKOTO_BROWSER_BINARY=/absolute/native RUUKOTO_BROWSER_CHROME=/absolute/chrome npx tsx .scratch/agent-browser/probes/runtime-sdk-acceptance.ts
npx tsx --test test/browser-lifecycle.test.ts test/browser-tools.test.ts test/101-instance-lock.test.ts test/29-cli-entry.test.ts
```

源码发生实质变化后只复核受影响项；审查指纹与正式回归指向最终主工作区，旧阶段 0 记录继续作为平台事实，不冒充最终源码全文验收。

## 真实模型与产品验收

真实模型入口已实现，默认离线跳过。明确选择一次视觉模型验收后，提供独立的 models.json 和固定程序路径：

```bash
RUN_MODEL_CHECK=1 RUN_BROWSER_MODELS_FILE=/absolute/models.json \
RUUKOTO_BROWSER_BINARY=/absolute/native RUUKOTO_BROWSER_CHROME=/absolute/chrome \
npx tsx --test test/browser-model-acceptance.test.ts
```

该配置只读显式文件，不读拥有者默认凭据；选择声明且 SDK 实际支持 image 的模型。双产品读取只画在 canvas 的随机六位短码，截图后填写并提交，要求服务端一次且答案正确；其他工具、重复提交、图片记录缺失或纯文本模型都会失败。配置、浏览器或 sandbox 前提缺失是失败/不可验证，不是通过。成功与失败均保留隔离档案并停止自己的浏览器。

[真实模型双产品 2/2 通过](real-model-acceptance.json)，使用拥有者显式配置的 `workbuddy-ai/step-5-preview`，随机短码正确且各 POST=1。首轮因裸 eN 被拒后纠正导致严格 all-calls-success 断言失败；补引用规范化后按原标准重跑通过，没有降低验收。拥有者还需验收有头/dashboard 人工登录、暂停后的新消息继续、接管已有浏览器与截图完整取回的体验。Linux 生产机器需补持久空间、系统库和可用 sandbox；无 expires 的会话 Cookie 不保证跨关闭延续。工单保留待人工/环境验收，不标 resolved。
