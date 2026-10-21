# Agent Note: 文件发现与内容检索共用受控读取范围

Status: implemented

## 问题

Coding能经bash运行rg，但只读调研缺少稳定的目录发现和内容搜索接口；个人工具只读已知普通文件，主会话不能靠独立子命令目录发现已授权资料。直接使用上游grep/find还会引入工具调用时下载rg/fd及宿主spawn，绕开已有执行归属。

## 决定

Coding 提供 list_files 和 search_files；个人接入仍由独立工单持有，未装配到个人 durable。两端沿同一参数和结果契约。字面检索和单个glob覆盖首版需求，工具只负责发现和定位，不建立索引、不修改文件。具体schema、固定预算、资格和结果位于[共享规格](../../../../.scratch/agent-tool-completion/spec.md#1-文件检索)。

复用已安装rg及现有worker/native边界，参数数组调用，禁止调用时下载或退回宿主扫描。固定排除父级/global/config影响，使同一授权根的检索不隐式依赖用户HOME配置。无glob时沿根内ignore并跳隐藏；显式glob沿rg原生语义可以覆盖ignore/隐藏过滤，但仍不跟随链接、不接纳二进制文件或扩大授权。描述和结果说明此区别，不为维持表面简单而承诺不存在的过滤保证。先捕获原流，再裁模型预览，区分扫描不完整与展示截断，避免漏项被当作无匹配。

共享 file-search 模块持有参数、schema、argv 和解码契约；Coding 的 worker 持有扫描和解析，路由持有来源、授权和产物。个人适配不得接入旧 Store；其资料目录不等于命令目录，后续递归读取仍须在原生只读范围中完成。目录身份、链接和授权变化在开始前核实，结果不是后续读取的授权或文件快照。原生别名核实使用 Buffer 路径枚举和 stat，保留非 UTF-8 文件名原字节；检索 worker 才把无法表示的结果转成具名编码失败，避免前置核实因替换字符误查另一条路径。

## 既有笔记审计

按文件检索、grep、glob、readRoots、资料授权与工具worker检索proposed和implemented；rejected目录不存在。下列为部分重叠：[原生执行](../../implemented/architecture/2026-10-10-native-execution-sandbox.md)持有受限范围及停止；[个人通用工具](../../implemented/architecture/2026-10-17-personal-tools-access-artifacts.md)持有原生接纳、资料授权和原字节；[个人资料与历史](../../implemented/architecture/2026-10-18-personal-memory-skills-history.md)持有历史/记忆身份，不能把文件检索当历史检索；[工具工作进程](../../implemented/architecture/2026-09-20-tool-worker-per-task-container.md)保留执行位于边界内的要求。各篇原决定保留，本篇只补检索工具。后台进程和结构化提问命中属于无关能力，没有完全吸收或过时提案。

## 备选方案

- 继续只用bash/子Agent命令：无需新增工具，熟悉rg的模型可完成；个人主会话没有相同目录/权限的命令入口，只读角色也不应为检索取得任意Shell，因此补结构化工具。
- 直接注册Pi grep/find/ls：已有schema和输出格式，接入短；当前实现会下载工具，grep的真实spawn不受自定义文件Operations控制，不能直接注册宿主版本。
- 用标准库重写递归和内容匹配：没有rg环境前提；需要自行维护ignore、编码、二进制和性能行为，选择复用已维护工具，缺失显式报错。
- 建持久索引并支持语义查询：大型资料检索可复用结果；引入更新、撤权删除和索引身份的新契约，首版按实际文件扫描。

## 后果

- Coding 的普通、Plan、只读/写入 SubAgent、宿主固定评审和原工作流能力可检索；显式旧角色工具快照仍只继承原清单，不改写持久授权。宿主固定评审定义摘要变化后，旧固定定义沿原校验明确拒绝，不迁移成新工具集。
- 根越界、链接、目录替换、父级/global ignore干扰、显式glob覆盖隐藏/ignore、rg缺失及非零退出都有最窄用例，不在宿主绕行。
- 预览裁剪仍可读完整证据；捕获/时间预算中止必须partial，取消无写入效果但仍核实执行停止。
- macOS/Linux真实受限边界与模型闭环分别记录，个人来源恢复仍未实施；测试及证据由[实施工单](../../../../.scratch/agent-tool-completion/issues/01-coding-file-search.md)持有。

新增 rg 环境前提；setup 只检查、不下载。列文件的 rg --files 不过滤二进制，worker 因此对普通候选分块检查 NUL 至 EOF；内容命中等对应 end 无 binary_offset 后才接纳，不让晚发现的二进制保留早期命中。额外读取沿同一预算，文本文件多的大目录更容易达到时间限制。原始 rg 流按原字节保存，可能包含最终被二进制判定排除的早期记录，模型预览和 capturedCount 只计接纳的文本命中。

大目录扫描仍有时间与输出预算，不提供稳定分页或完整快照。以后确有持续的大资料检索需求才重访索引，不能通过提高预算或去掉授权检查掩盖缺口。
