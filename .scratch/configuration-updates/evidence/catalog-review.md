# 目录、凭据与检索独立实现复核

审查者为主代理 root，所审代码由 catalog_credentials 的独立实施上下文编写。直接核对规格 A4、A6、A12、调用方、实际差异及定向回归；root 自己编写的设置基础与桌面代码不计入本篇独立审查。

## 结论

所审范围无未解决阻断。Code 目录保存仅排除 provider/model 显示名和按唯一 ID 排序；原模型被删除、原执行字段或高级字段变化仍进入受影响提供方检查。新增 ID 与当前实际 SDK 目录核对，覆盖内置 ID 仍按执行变化处理；重复 ID 在结构校验拒绝。原修订检查、完整模型栈重建、回滚和关闭等待仍执行，未把展示变更当成跳过保存流程。

MCP 凭据只为新增、重新启用或认证/Cua 绑定变化的服务解析；停用、删除和未改认证项不因旧凭据失效被拦。实际调用仍重读原引用并核实摘要，不降级匿名；新服务显式选择认证、非法引用、未知效果与原调用身份负例保留。托管 Skills 的 prepare 只发布不可变包及候选清单，PA 在持久意图之后才替换选择；Code 原直接提交方法复用相同准备逻辑，原路径/权限/修订验证保留。

Coding worker 在每次检索实际调用前解析其继承 PATH 中的 rg，初始协议不再钉住缺失结果；PA 也逐次解析。诊断明确区分现有 PATH 内安装和改变后台 PATH。既有原生沙箱不能因此看到原先未开放的新安装目录，此限制已在决定与验证材料写明，没有静默扩大执行根。

## 实际验证

主区执行 `npx tsx --test --test-concurrency=2 test/31-model-config.test.ts test/file-search.test.ts test/personal-cli.test.ts test/personal-command-config.test.ts`，79项中77通过、2个 Linux 平台用例跳过、0失败。模型目录部分覆盖运行、排队、待确认、SDK 内置覆盖、重复 ID 及重建失败回滚；文件检索部分覆盖同一 worker 初次找不到、临时 PATH 内安装后再次发现。MCP 配置/恢复与 Skills 的完整相关组合另有124/124、29/29及120/120主区回归，具体范围见[实施证据](implementation.md)，不累加成一个独立总数。

这些是本机替身、实际 worker/文件和 SDK 模型栈测试，不是外部平台或生产部署验证；真实模型结果与 Linux 环境分别记录。

## 文件指纹

- `packages/runtime/src/models.ts`: `125cfdea38d48e0e90fb5237ebc30ae23c9313e6051e0f5e346fdbe00fa72044`
- `packages/agent/src/model-config.ts`: `778050b4840f6b6457a369ae5eb407554ea62ba08d5efd24e7ef806d9fce66b9`
- `packages/agent/src/tool-worker/host.ts`: `1e4be9b0527ed4a9e541add5ab46c498d7fd42309cd3af9f342287ab25ecc0a9`
- `packages/agent/src/tool-worker/protocol.ts`: `6f83ac579489713abf5a67bfe3e1793725e3ad1adfad83aab89de0ba89ed9c67`
- `packages/agent/src/tool-worker/worker.ts`: `d4da059e3730d27426d3d8f697c60d5280595690745b650ae9cda1bf9e2aaaae`
- `packages/agent/src/tool-worker/file-search.ts`: `4b88f2e7010c4a9c39e0e64cb8372ff0917781eec2812f35e0687a8f43e658df`
- `packages/agent/src/managed-skills.ts`: `ddd3743229474593dc004bf082d68a349ee06d73cf5718f3f57854a35a64abbe`
- `apps/ruukoto/src/personal-file-search.ts`: `8ecb607d3f16fcfd47ff29a02046b0458c02322688e26c41f28ca04c2763ebcf`
- `apps/ruukoto/src/personal-mcp-config.ts`: `23df78a90e8abf19ca93152211e11ef5a6e0115ce2409b4f1c84d126e150c7a0`
