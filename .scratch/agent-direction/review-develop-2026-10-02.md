# develop 最近五次提交评审记录

评审日期：2026-10-02（Asia/Tokyo）。

本次确认 5 个 P2 问题：Standards 轴 2 个，Spec 轴 3 个。以下问题均待修复；记录评审结果不代表已完成修复。

## 评审范围

基准提交：`ff289e2a4ee5281ffc6ea81f7c9ddeda79893e20`。目标提交：`606e15f930e2988c2e277756d733cfdd600fd604`。代码位置与行号均对应目标提交。

```bash
git diff ff289e2...606e15f
git log ff289e2..606e15f --oneline
```

按时间顺序审查以下提交：

1. `42fb710`：ruukoto-dev 产品入口与两产品独立启动（工单 01）。
2. `f18470d`：TUI 打开时按需拉起本机后台（工单 02）。
3. `6f38667`：开发机执行边界验证与记录（工单 03）。
4. `e7b4d11`：开发机受限与完全访问接入开发任务（工单 04）。
5. `606e15f`：按工作区创建和切换开发会话（工单 05）。

依据：[方向规格](spec.md)、[ADR 0017](../../docs/adr/0017-two-agent-products.md)、[运行说明](../../docs/runtime.md)，以及工单 [01](issues/01-independent-products.md)、[02](issues/02-coding-daemon.md)、[03](issues/03-execution-boundary-proof.md)、[04](issues/04-desktop-execution.md)、[05](issues/05-workspace-sessions.md)。

## Standards

### R1 — [P2] 旧项目认领绕过目录身份去重

位置：[src/core/store.ts](../../src/core/store.ts)，`attachProjectRoot`，第 165—169 行。关联工单：[05](issues/05-workspace-sessions.md)。

`attachProjectRoot` 直接更新根目录字段，只依赖 `root_real` 唯一索引，没有复用 `findProjectByRoot` 对 realpath 或 dev+ino 的身份判断。Linux bind mount 别名可能具有不同 realpath、相同 dev+ino；两个旧项目分别认领这两个路径后，会留下同一目录身份的两个工作区，后续自动归属取决于查询顺序。

复现证据：在临时 Store 中先创建根目录身份为 `/first`、dev=1、ino=2 的工作区，再将另一个旧项目认领为 `/bind-alias`、dev=1、ino=2，更新成功且保留两个工作区。本次使用合成目录身份验证存储逻辑，没有执行真实 Linux bind mount 探针。

修复建议：更新前复用现有目录身份查询，拒绝已归属其他项目的目录。验收时应覆盖相同 dev+ino、不同 realpath 的认领冲突，以及同项目相同身份的幂等认领；冲突后不得新增归属或事件。

### R2 — [P2] SQLite 根目录冲突匹配错误

位置：[src/core/store.ts](../../src/core/store.ts)，`isRootDirClash`，第 1885—1887 行。关联工单：[05](issues/05-workspace-sessions.md)。

代码通过索引名 `idx_projects_root_real` 判断冲突，但 node:sqlite 对该部分唯一索引实际返回 `UNIQUE constraint failed: projects.root_real`。旧项目认领已占用的相同 realpath 时，原始异常未被转成 `StoreConflictError`，控制面返回 `internal_error`，客户端将明确的归属冲突视为应答丢失，进入应答丢失处理。

复现证据：临时 Store 中认领已占用的根目录，抛出 `Error / ERR_SQLITE_ERROR`，错误正文包含 `projects.root_real`，没有索引名。

修复建议：沿用 `isCreateRequestIdClash` 的列名匹配方式。验收时应确认同 realpath 冲突返回明确的 `duplicate`，事务不留下新会话或根目录归属，客户端不进入应答丢失处理。

## Spec

### R3 — [P2] 后台探测忽略已配置的令牌来源

位置：[src/control/ensure-backend.ts](../../src/control/ensure-backend.ts)，`ensureBackend`，第 69—72 行；就绪轮询也采用相同读取方式。关联工单：[02](issues/02-coding-daemon.md)。

探测直接调用 `readOwnerToken` 读取控制目录的 `owner.token`，绕过支持 `RUUKOTO_OWNER_TOKEN` 和 `RUUKOTO_OWNER_TOKEN_FILE` 的 `resolveOwnerToken`。后台与拥有者使用不同 UID、原令牌文件不可读但拥有者持有有效副本时，既有客户端能够认证，新增探测却报告认证失败，TUI 在解析正常客户端配置前退出，不能复用已运行后台。

复现证据：通过真实 Runtime/socket，将后台已加载的令牌文件移到 `RUUKOTO_OWNER_TOKEN_FILE` 指定位置；`resolveOwnerToken` 配合控制面探测可以认证，`ensureBackend` 却返回认证失败。该复现模拟原文件不可读的读取结果，没有创建不同 UID 的部署。

修复建议：首次探测及就绪轮询复用客户端的令牌来源规则，同时允许尚未启动、尚无令牌的后台继续进入启动流程。验收时覆盖环境令牌、令牌副本和默认文件；有效凭据应复用后台，错误凭据应明确拒绝且不重复启动。

### R4 — [P2] npm start 路径无法按需启动后台

位置：[src/control/ensure-backend.ts](../../src/control/ensure-backend.ts)，默认启动参数，第 88—89 行。关联工单：[02](issues/02-coding-daemon.md)。

运行说明支持 `RUUKOTO_PRODUCT=ruukoto-dev npm start -- …`。该路径由 tsx 执行 `src/cli.ts`，因此 `process.argv[1]` 指向 TypeScript 文件；按需启动却使用裸 `node` 派生 `src/cli.ts server`，没有 TypeScript loader。后台加载含参数属性的类时发生语法错误，按需启动失败。

复现证据：macOS 本机 Node 24.15.0，使用默认派生路径调用 `ensureBackend` 返回 `ok: false`，日志包含 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，指向 `src/agent/model-selection.ts` 的 TypeScript 参数属性。以下命令也可单独确认被派生的后台入口错误：

```bash
RUUKOTO_PRODUCT=ruukoto-dev node src/cli.ts server
```

修复建议：使用能够加载 TypeScript 的固定服务入口，或为 TypeScript 入口配置 loader。验收时分别覆盖真实 bin 入口与文档支持的 npm start 入口；两者都应能首次拉起后台，并在再次打开时复用同一实例。

### R5 — [P2] 旧项目候选与后台认领条件不一致

位置：[src/control/workspace.ts](../../src/control/workspace.ts)，`findWorkspaceProjects`，第 73—76 行；后台拒绝点见 [src/runtime/runtime.ts](../../src/runtime/runtime.ts)，第 1053—1055 行。关联工单：[05](issues/05-workspace-sessions.md)。

含普通 dev 会话及群聊或角色会话的混合旧项目会成为目录候选，但 `openWorkspace` 随后拒绝认领整个项目。唯一候选场景下，路径入口自动发送必遭拒绝的 `project_id`，不能创建工作区会话。候选筛选与后台防御条件不一致，破坏工单 05 要求的目录打开及旧数据兼容路径。

复现证据：通过真实 Runtime 创建含普通 dev 和 `qq_group` 会话的旧项目，客户端候选为 `mixed`，对应 `open_workspace` 请求返回 `invalid_params`，未创建工作区。现有 test/74 只覆盖纯角色、纯群聊项目拒绝认领，另有断言要求混合旧项目保留在普通选择列表，未覆盖这条路径入口。

修复建议：使目录候选筛选符合后台可认领条件，保留混合旧项目中普通会话的查看与切换能力。验收时覆盖混合旧项目的目录打开，避免自动发出必遭拒绝的认领请求；纯角色、纯群聊项目仍应受到后台保护。

## 验证记录

评审期间执行以下检查：

```bash
npm run typecheck
npx tsx --test test/07-real-tools.test.ts test/30-workspace-entry.test.ts test/67-visual-docs.test.ts test/71-product-entry.test.ts test/72-on-demand-backend.test.ts test/73-desktop-execution.test.ts test/74-workspace-sessions.test.ts
```

类型检查通过；相关测试共 63 项，全部通过，无失败或跳过。五个发现通过额外临时复现确认，现有测试通过不代表覆盖了这些边界。临时复现未新增持久回归测试。

执行与停止路径未发现本次新增的可确认缺陷；基线已存在的问题不计入上述五项。本次评审未重新执行全量 `npm test`、真实模型调用或 Linux 部署隔离验证。
