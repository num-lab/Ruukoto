# Agent Note: MCP 图片结果复用双端产物与模型恢复

Status: implemented

## 问题

Code 的 MCP 结果整形忽略图片，isError 抛错也会丢附件；Personal 保存完整应答但只给模型摘要。[Cua 提案](../../proposed/architecture/2026-10-23-cua-official-mcp.md)的观察必须成为实际模型输入，并能从历史恢复，图片失败不能把已收到的动作应答改成效果未知。

## 决定

共享无状态 `mcp/images.ts` 按原 content 索引校验内联图片：最多4张、单图8MiB，解码前检查数量和编码长度，解码后检查规范base64、JPEG/PNG/WebP实际签名与声明MIME及SHA-256。错误占据原内容位置，其余合法图片仍可展示；音频和资源链接只说明类型，不下载。文本继续有界预览，图片独立于文字截断。

Code 先写 ArtifactStore 不可变图片，再返回带 `ruukotoMediaRef` 的空视觉块；SDK历史保存内容顺序、原toolCallId及引用，task.tool_result保存产物ID。现有发送边界核实哈希和归属后恢复原字节，prompt快照保存引用。空正文避免pi对原截图再次缩放；MCP专用tool_result钩子从宿主details设置isError，错误图片不会因抛异常丢失。旧文本结果与普通HTTPS调用、权限和错误分类沿原路径。

Personal 在完整应答已提交后，将图片保存为私有产物并批量registerImages，归属仍是原pi.tool Task。批量先核实同一Task，再登记图片，遵守durable写表后不再读任务表的约束。可选version 1 imageProjection与不可改ruukoto.mcp-images entry保存有序文字/图片引用及图像问题；恢复双向核实entry、原响应索引和图片哈希。provider仍按原工具结果和媒体反链恢复；原请求/应答证据保留，新图片记录的分页视图将base64替换为引用。缺投影的旧记录沿旧摘要读取，不在启动时改写。图片处理的正常错误单独返回图像问题，登记事务失败先回滚再记录问题，原effect/code/remoteEnded不受影响。

### 既有决定审计

[读取图片](../../implemented/bug-fix/2026-10-12-read-images.md)与[个人图片](2026-10-18-personal-browser-media.md)部分重叠，继续持有本地read与provider规则；本篇仅扩展MCP。 [个人MCP](2026-10-17-personal-durable-mcp.md)的完整应答与未知占用不变，图片分页投影由本篇补充。[共享传输](2026-10-17-mcp-transport-reuse.md)仍持有HTTP传输，本篇不承诺stdio已接入。没有完全吸收或失效提案。

## 备选方案

- 直接将base64作为工具文本交模型，改动最少；模型得不到视觉内容且文本截断会破坏图片，故不选。
- Code让SDK保存完整图片正文，可以复用本地read路径；但会重复落盘并可能再次缩放截图，因此沿既有产物引用恢复。
- Personal套用旧ArtifactStore/Task Store可复用完整格式；会引入第二份运行权威，故只复用校验，字节和引用沿现有媒体链。
- 每张图片独立commit能避开事务读写限制；会留下部分登记、部分未登记的投影，采用同Task批量登记和一次投影提交。

## 后果

双端实际provider输入与原工具、内容顺序和哈希可重建；完整应答后的坏图、超限和落盘失败不引导重做原动作。文件与数据库不跨存储原子，事务失败可能留下未引用的私有图片文件。这里只识别文件签名，不保证图片内容可被模型解码；原截图不自动缩放，provider的自身图片预算仍可能拒绝请求。

离线校验与模拟provider不能证明真实视觉效果。正式stdio每消息48MiB预算及Cua无视觉模型的动作前拒绝由03接入；当前尚无Cua配置分类，普通HTTPS工具不能因未知返回类型一律拒绝文本模型。工单02交付图片转换，正式产品验收由[05](../../../../.scratch/cua-integration/issues/05-acceptance.md)持有，执行证据见[02](../../../../.scratch/cua-integration/issues/02-mcp-images.md)。
