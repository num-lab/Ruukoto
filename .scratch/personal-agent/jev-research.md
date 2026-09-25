# Jev 接入前核实

核实日期：2026-09-25。范围为 issue 08 的官方 API、访问条件、费用、数据处理条款及既有参考实现。本次只读取公开文档、GitHub 源码与 npm 元数据，没有注册账号、购买额度、读取本地 Jev 凭据或向 Jev 提交任务内容；没有完成真实 API 调用及效果测量。

## 接入判断

公开资料足以实现一个默认关闭、凭据与启用状态均由拥有者配置的实验适配器。建议直接按官方 HTTP 合约实现窄接口，复用本项目的基础上下文规则、凭据存储和超时机制；两个社区插件只作设计参考。本判断属于工程推论，不能证明拥有者账号已经获准访问，也不能证明真实历史的筛选质量或费用收益。上线后仍以基础规则为默认，真实调用需要拥有者提供有效凭据并启用实验。

## 官方 API 与模型

评估端点为 `POST https://api.typesafe.ai/v1/systemone`，鉴权为 `Authorization: Bearer <API_KEY>`，内容类型为 `application/json`。请求必须包含 `model`、`state` 与 `questions`；`state` 可为字符串、对象或数组。问题以调用方选择的 ID 为键；ID 仅作请求与响应映射，不参与模型推理。API 记录了 `401`、`422`、`429` 与 `529`，其中后两者分别表示限流与服务过载。[官方 API](https://docs.typesafe.ai/api)

本实验只需要 Noul：每个问题包含 `type: "noul"` 和 `instructions`，可选 `criteria.true`、`criteria.false`。回答是“是”的概率，不是相关程度，也没有单独的 `confidence`。以下是合约示意，正文与 ID 为本项目自拟，数值是假数据。[官方 Noul 文档](https://docs.typesafe.ai/primitives/noul)

```json
{
  "model": "jev-1.13.0",
  "state": { "task": "找回已确认的构建命令", "candidate": "构建命令为 npm run build" },
  "questions": {
    "keep_0": {
      "type": "noul",
      "instructions": "Does the candidate contain information needed for the current task?"
    }
  }
}
```

```json
{
  "model": "jev-1.13.0",
  "answers": { "keep_0": { "type": "noul", "noul": 0.95 } },
  "usage": { "input_tokens": 100, "output_tokens": 20 }
}
```

当前固定版本为 `jev-1.13.0`，`jev-latest` 与 `jev-preview` 当日均指向该版本；别名后续会移动。请求总量上限为 64k tokens，另有 `state + 最长单个问题 <= 32k tokens` 的限制。仅支持文本；公开速率为每秒 250,000 tokens、每分钟 1,200 请求，官方说明限额可能动态调整。英语效果目前最好，中文等语言需要单独验证。[官方模型说明](https://docs.typesafe.ai/models)

工程上应固定版本并记录响应的实际 `model`，逐个校验回答的 ID、`type`、有限数及 `[0, 1]` 范围。模型视图的预算、完整交互配对、当前任务及宿主指令保留由本地代码执行；未知、缺失或非法回答回退基础规则。由于没有官方 tokenizer 的本地精确计数，本地估算只能作为保守请求上限，服务拒绝超限时仍需回退。

## 访问条件和费用

官方 Quick start 要求登录控制台并在 dashboard 获取 API key。2026-09-15 的发布公告仍称 early access，并提到逐步从 waitlist 开放；本次未找到能证明所有新账号均已开放的官方承诺。未登录的控制台仅能确认存在 Google 与邮箱登录入口，无法核实拥有者账号资格、区域支持或可用额度。[Quick start](https://docs.typesafe.ai/introduction/quickstart)、[发布公告](https://typesafe.ai/blog/introducing-system-one-models-and-jev)、[控制台](https://console.typesafe.ai/login)

公开价格为输入每百万 tokens **US$0.042**，输出免费；响应 `usage.input_tokens` 可用于估算单次输入成本。按此单价计算，20,000 个输入 tokens 约 **US$0.00084**；这是算术估算，没有包含主模型缓存变化等成本，也不是实测账单。[官方价格与模型](https://docs.typesafe.ai/models)

MCA 要求账户持有可用 credits；赠送额度不是承诺，余额不足时可拒绝生成结果。自动补充额度需要主动选择；通常购买额度在 12 个月或合同终止时失效，以更早者为准。本实验不代办账号、购买额度或开启自动充值。[MCA §8.2](https://typesafe.ai/legal/mca)

## 数据处理与保留

隐私政策最后更新于 2025-11-19，覆盖 API：会收集提交的 prompts、data、instructions 等 Input，承诺不使用 Input 训练或微调模型；Input 可交由服务提供商处理。服务托管于美国。普通保留表述为提供服务或商业目的合理需要的期限，没有固定天数。[Privacy Policy](https://typesafe.ai/legal/privacy-policy)

DPA 最后更新于 2026-04-24，客户为控制者、TypeSafe 为处理者，按客户书面指令提供服务；Schedule I 的保留标准仍是处理目的及法律所需，没有给出请求日志的删除时间上限。分处理者指向 Trust Center，本次公开抓取未能取得可核验名单。[DPA](https://typesafe.ai/legal/data-processing)、[Subprocessors](https://trust.typesafe.ai/subprocessors)

MCA 页面最后更新于 2026-09-23。§4.1 禁止未经客户事先同意将客户数据用于训练模型权重，同时保留为遥测、反滥用及法律要求处理数据的权利；§4.3 对遥测另作规定；§5 要求客户具备输入资料所需的权利和同意。不能把“不训练”解释为“不保留”或“无人处理”。[MCA §4–5](https://typesafe.ai/legal/mca)

官方只对企业客户列出 ZDR，并要求联系销售。当前未确认拥有者账号适用 ZDR、具体日志保留期限、分处理者名单或单独的区域安排；因此不得默认把真实任务内容当作零保留数据发送。[官方 Legal 页面](https://docs.typesafe.ai/legal)

以上是公开条款事实摘录及工程影响，不代表已核实拥有者账户的个别合同。本项目的配置说明应明确披露：启用后，选中的任务相关文本会发送给 TypeSafe，普通账号没有已确认的零保留保证。

## 社区版本、许可与复用范围

通过 GitHub 的默认分支元数据与固定提交文件交叉核对，当日参考版本如下；这里的版本为仓库 `package.json`，不能视作同名 npm 包的发布身份。

| 参考项目 | 核实的 main commit | 仓库版本 | 许可 |
| --- | --- | --- | --- |
| `tamaratran/fast-jev-compaction` | `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`，2026-09-17 | `0.2.0` | MIT，版权行 `Copyright (c) 2025` |
| `QuentinDanblon/pi-fast-jev-compaction` | `679041b8511515c9a0fcebd617afebabd87ae7f6`，2026-09-18 | `0.1.0` | MIT，Copyright 2026 Quentin Danblon；保留上游 MIT 声明 |

原始实现依据：[commit](https://github.com/tamaratran/fast-jev-compaction/commit/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0)、[package.json](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/package.json)、[LICENSE](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/LICENSE)。pi 移植依据：[commit](https://github.com/QuentinDanblon/pi-fast-jev-compaction/commit/679041b8511515c9a0fcebd617afebabd87ae7f6)、[package.json](https://github.com/QuentinDanblon/pi-fast-jev-compaction/blob/679041b8511515c9a0fcebd617afebabd87ae7f6/package.json)、[LICENSE](https://github.com/QuentinDanblon/pi-fast-jev-compaction/blob/679041b8511515c9a0fcebd617afebabd87ae7f6/LICENSE)。若复制实质代码，必须连同版权与许可声明保留。

pi 移植的 vendor 明确钉在原始实现上述 commit，保存构建产物及上游许可证。README 的“npm 尚未发布”已经不能作为当前结论。[PROVENANCE](https://github.com/QuentinDanblon/pi-fast-jev-compaction/blob/679041b8511515c9a0fcebd617afebabd87ae7f6/vendor/fast-jev-compaction/PROVENANCE.md)、[README](https://github.com/QuentinDanblon/pi-fast-jev-compaction/blob/679041b8511515c9a0fcebd617afebabd87ae7f6/README.md)

当日 npm 元数据中，`fast-jev-compaction` 的 latest 为 `0.4.1`，maintainer 为 `aleksvega`，没有 `repository` 字段，`gitHead` 为 `5b8d1d08f29c026db176180afc79cada8f242760`；本次不能证明它与 tamaratran 仓库的发布关系。同名 `pi-fast-jev-compaction@0.2.0` 明确指向 `ross-jill-ws/pi-fast-jev-compaction`，属于另一仓库。**不能仅凭包名安装并认为获得上述参考代码。**[fast-jev-compaction registry](https://registry.npmjs.org/fast-jev-compaction/0.4.1)、[pi-fast-jev-compaction registry](https://registry.npmjs.org/pi-fast-jev-compaction/0.2.0)

原始实现的 `JevClient` 没有内建超时；`noulAnswer` 校验有限数字，但不校验 `[0, 1]` 或回答类型。直接复制它仍需补本项目的边界校验。它的任务是工具调用筛选，本项目还需保留自身基础预算规则，完整集成成本高于一个最小 HTTP 适配器。[client.ts](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/client.ts)、[request.ts](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/request.ts)

## 实验边界与待验证事项

官方列出的 Jev 1.13 已知问题包括：无关长文本降低准确性，问题中的间接指代影响结果，state 中的攻击性指令可能改变回答。这些限制支持把 Jev 放在可失败、可恢复的模型视图选择环节，不能把概率结果当作宿主权限或资料授权依据。[官方已知问题](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

建议首轮实现及离线验证覆盖以下事实，而不预设 Jev 优于基础规则：

- 未启用、缺凭据时零调用；凭据只能由宿主管理，任务正文不能启用实验或改目标端点。
- 固定历史分别跑基础规则和预设 Jev 响应，列出保留/排除的交互及可查回来源；结果必须称为离线回放，不能声称验证真实模型效果。
- 超时、取消、HTTP 错误、非法 JSON、缺回答及非法概率均回退；外部请求失败后不要在主模型调用路径自动无限重试。
- 选择前后原始持久历史保持完整；当前任务、完整工具交互、指令和已有资料边界保持本地可验证。
- 拥有者实际启用后，再用同一固定历史记录真实模型版本、输入用量、延迟、失败率与历史信息找回情况；从主模型请求成本中扣除 Jev 成本与缓存变化，之后才判断默认策略。

尚未完成的真实验证：账户资格与 credits、特定账号数据保留安排、中文历史筛选准确性、当前网络下实际延迟、真实费用及主模型缓存影响。本次研究不将社区 README 的节省比例或 TypeSafe 的速度宣传列为本项目实测结果。
