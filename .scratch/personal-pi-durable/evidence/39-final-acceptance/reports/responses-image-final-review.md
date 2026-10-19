# 工单 39：Responses 工具图片实现独立审查

结论：不阻断。实际补丁与方案一致，仅让已知 Responses function_call_output 的 output 数组进入既有图片字段转换；来源/字节/MIME 核实和 seen/expected 精确计数均未放宽，普通工具参数与字符串不递归解析。新增 Note 锚点、个人 durable 模块文档与决定笔记均和当前范围相符。

## 固定对象

只读审查根仓库个人媒体实现和新增用例，未改根仓库。运行前后文件 SHA-256 保持：

- `apps/ruukoto/src/personal-media.ts`：`9de922c4e9a031993229c997abea238bc6a688bd1de79d0971498e08d74cdedd`。
- `test/personal-media.test.ts`：`8aa5f35ed38d7bd0c071ef8ba349e181f068245ecd31a0b8f605168ff75e05f4`。

SDK 的实际 convertToolResultOutput→function_call_output.output 路径与此分支一致。没有加入不可达 grammar custom 类型支持，也没有扩大成任意 JSON walker。失败仍发生于 recordedModels 的 payload 记录前，不能绕过未核实图片调用模型。

## 仓库最窄用例

执行 `node --import tsx --test --test-name-pattern='Responses原生工具图片|普通工具参数中的|普通文字中的图片JSON' test/personal-media.test.ts`，3/3 通过、0 跳过，约1.60秒。包含 Responses 正常与四个变造路径，以及普通文字和工具业务JSON不被误解释。日志 `/tmp/ruukoto39-responses-image-independent.log`。没有重跑28项或静态全组。

## 独立落盘与 HTTP 探针

在 `/tmp/ruukoto39-responses-image-proof/proof.test.ts` 复制同一测试，仅增加观测，不改根。将 record 返回的每个 entry 用独立 read-only DatabaseSync 连接按 entry.id 从真实 entries 表读回，和提交值逐项比较，并检查保存记录没有 data:image URL、原 PNG base64 或 JPEG base64。正常路径的两条映射分别为 inbound 与 tool。

Responses 探针期间替换 globalThis.fetch 为计数且拒绝的函数，随后恢复；不仅依赖 mock server 调用数。结果如下：

| 路径 | 保存 input | 保存 payload | 流结果 | fetch 尝试 |
| --- | ---: | ---: | --- | ---: |
| 正常 JPEG 入站＋PNG 工具图 | 1 | 1 | 主动 aborted | 0 |
| 工具图片字节变造 | 1 | 0 | error | 0 |
| 删除工具图片 | 1 | 0 | error | 0 |
| 未登记外链工具图片 | 1 | 0 | error | 0 |
| 重复工具图片 | 1 | 0 | error | 0 |

正常路径是 await durable commit、独立 SQLite 回读成功后才主动 abort，因此同时证明实际 SDK 序列化、合法 payload 可保存和保存后阻止网络。四反例在 snapshot 阶段拒绝，无 payload 记录。夹具预先产生两次本机 mock HTTP 用于登记图片来源；上表零次限定为后续 Responses 序列化探针，未把准备阶段隐去。

该临时窄探针1/1通过、0跳过，约1.05秒；日志 `/tmp/ruukoto39-responses-image-proof.log`，逐路径事实及6次实际SQLite回读在 `/tmp/ruukoto39-responses-image-proof/proof.json`。临时复制初次启动因外部文件缺ESM包声明/Chord子路径解析失败，未运行测试；已仅修正/tmp装载设置后执行成功，原失败保留 `/tmp/ruukoto39-responses-image-proof-initial-loader-failure.log`，不归因产品。

## 范围

以上为真实 SDK＋真实 durable SQLite、离线模型/图片夹具的检查，不是真实视觉模型或真实 IM。JPEG夹具用于MIME/序列化分支，不声称做真实图像解码验收。未读取模型/IM凭据，未访问 live-profile、真实QQ新图或observer。真实组合重试仍由根持有。
