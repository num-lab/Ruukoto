# Coding Agent 工具完善

Status: ready-for-human

## 目标与边界

拥有者于 2026-10-25 要求新增 `present`、`search_tools`、通用 `wait` 和网页正文读取，随后确认本次只覆盖 `ruukoto-code`。当前代码的等待名为 `agent_wait`，网页读取只有 `http_request`；以实际入口为改动基线。

`present` 指定文件或 HTTP(S) 网页，在桌面来源会话侧栏打开。文件按任务读取权限生成不可变产物，再复用 Read 快照；不借拥有者文件树接口放大 Agent 读取权限。网页复用隔离浏览器，按[后续决定](02-preview-permissions.md)在四种会话模式直接登记，不要求完全访问或审批，不传凭据、不接受其他 scheme。工具回执只证明预览请求已记录，不声称客户端已加载。无桌面连接仍保存可查请求；历史重放不自动打开，工具行可重开。

文件格式沿用现有预览：Markdown、UTF-8 文本与 PNG/JPEG/GIF/WebP；HTML 作为源码，PDF/SVG 明确不支持，不声称任意格式均可渲染。空文件也须能打开。

`search_tools` 对本任务获准 MCP 工具作关键词搜索，默认最多 5 个、上限 20 个，返回名称与描述，下一模型请求提供完整定义并激活到本任务结束。内建工具保持直接可见；无搜索工具资格的固定子代理/工作流工具清单保持现有直接暴露，避免无法发现其明确要求的能力。此处延迟的是模型可见注册，服务连接和 schema 核实仍在任务开始完成，不新增网络发现平台。

`wait` 替换模型可见的 `agent_wait`，沿用 SubAgent task / workflow run 等待与目录让出、报告认领。增加本会话 process 目标等待；一次等待一个后台进程，或一组现有任务/工作流，后台进程不参加工作流报告认领。等待超时、新输入或取消不停止目标；stopped 且 stopVerified 才算进程已停止，stop_unverified 返回需介入。内部存储、历史读取仍识别已存在的 agent_wait 记录，不迁移或删除历史。

进程主命令自然退出、尚未登记停止意图但整组未核实时立即返回 attention=command_exited，给出退出码、stopVerified=false 和 process_stop → wait 指引；wait 自身不停止仍工作的后代。进程等待登记内存中活动父任务，接入 Runtime.submit 的可信新输入中断点；沿既有 requestStop 收束父轮。返回统一 reason/targets，进程成员不带报告权，历史只消费 task/workflow。旧 agent_wait 保留 no_effect 恢复分类；后台已全部停止且本轮未中断时经原 restoreWorkspace 重取资源，其余状态不释放后台占用。

`web_fetch` 为固定 GET 网页正文工具，沿用 HTTP 审批、固定 DNS、只读效果分类和不重试、不自动重定向规则；返回来源、标题和可读正文，超长正文通过产物继续读取，真实截断明确标 partial。复用已安装 parse5，不用正则解析 HTML，不引入浏览器渲染或付费提取服务。

## 方案

1. 工具注册与模型接口：更新 routed / host tools、权限与 Plan 允许清单、操作账本、Driver 实际工具激活和历史消费识别。search 的候选资格与最终激活集合分开，伪造未发现调用仍拒绝；实际 prompt 快照保留每轮定义。
2. 等待：复用现有 RuntimeAgentWait 处理任务/工作流；进程通过原状态与事件订阅等待，保持 session 归属、权限版本、超时与取消检查；后台占用阶段开放 wait，但不让出或停止后台执行。
3. 预览：文件复用 worker read 与产物捕获；桌面从已提交成功工具结果打开 read-snapshot/browser，仅 live 事件自动处理。现有工具活动行可打开历史请求；失败不触发预览。
4. 正文：HTTP transport 暴露截断事实，新增有界 HTML 正文提取；不支持的二进制/编码或无正文返回可行动错误。依赖声明与锁文件、文档中的受影响依赖说明同步。
5. 更新 agent-tools、runtime、desktop 模块文档与决策笔记。按改动选定向测试，完成 check:static、受影响构建、独立实现审查；不把模拟模型/DOM 当作真实模型或原生桌面验收。

## 进展与交接

- 当前角色：工程验收完成，等待拥有者真实客户端体验验收。实施基点：83f212ad；开始时工作树干净，当前改动随本工单入库。
- 并行只读调研：tool_landscape 核对注册/SDK 刷新，preview_landscape 核对侧栏与权限；独立实现须用独立工作副本，主工作区仅根 agent 写入。
- 下一角色：拥有者，在Electron／MyGo确认自动预览及历史重开体验；源码实现与独立审查已完成。
- 阻塞：无；不需要重复确认已授权的四项能力及 Code 范围。

## 验收与证据

- present：真实权限读取/失败不打开、当前与非当前会话归属、live 打开与 replay 不抢焦点、历史重开、拒绝危险 URL；桌面 DOM 与后台分别验证，真实双壳体验单列。
- search_tools：初轮无延迟 MCP schema，命中后的下一轮含 schema 且可调用；未发现/未授权伪调用拒绝；无结果、上限、任务重置、Plan 与子代理固定能力覆盖。记录实际 prompt 的 toolSchemas/systemPrompt 前后估算。
- wait：任务/工作流原回归保持；后台停止、未核实、超时、取消、新输入、错误会话与重复目标覆盖；旧历史消费继续可核实。
- web_fetch：本地 HTTP 夹具验证正文去脚本/导航、实体/Unicode、标题与来源、纯文本、非文本、重定向、审批拒绝零发送、真实截断及产物续读。
- 工程验收通过。产品验收待真实侧栏体验；真实模型、外部服务与Linux未执行，不记通过。定向测试、静态检查、双壳构建与独立审查见[验收记录](../evidence/verification.md)，被审源码与文档见[文件哈希](../evidence/source-snapshot.json)。
- 独立方案审查：2026-10-25，preview_landscape 对完整工单及源码审查，tool_landscape 专项审查 wait；指出自然退出、新输入打断、旧账本分类及结果判别缺口，已按其建议修订，没有剩余方案阻断。实现审查由fetch_path（search）、preview_landscape（wait）、tool_landscape（web_fetch／present）分别完成，无剩余阻断；206部分响应误标完整已修复并复审。

## Comments

2026-10-25：拥有者通过异步选择确认先覆盖 Coding Agent；本工单保留个人 Agent 不变。

2026-10-25：完成四项实现、必要调用方与历史兼容，真实HTTP／worker／模拟模型和DOM定向回归通过；签名构建完成，未提交或部署。独立文档审查已收紧后台观测阶段与stop_requested条件，不增加权限。

2026-10-25：拥有者授权提交。提交前独立核对64个源码、测试与文档哈希全部匹配，无范围外文件，原验收证据继续有效；真实客户端体验仍待验收。

2026-10-25：拥有者要求去掉网页预览权限限制，后续实现与验证由[02](02-preview-permissions.md)持有；63077580的原权限验收只作为历史证据。
