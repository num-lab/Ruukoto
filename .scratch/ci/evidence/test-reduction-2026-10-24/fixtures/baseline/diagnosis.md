# baseline 三项失败的独立诊断

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../../../git-history-cleanup/archive.md)。

对象：HEAD 28c033f7，原版完整 baseline `/tmp/ruukoto-reduction-before-28c033f7.log` 中的三项失败。实际位置是 `test/19-tui-demo.test.ts:58`（不是43-desktop-demo）以及 `test/40-desktop-creation.test.ts:25` 的两项 rejected 展开用例（不是desktop-session-settings）。执行人只读主工作区，没有改动生产文件、测试文件或本次baseline。

## 红绿反馈

完整命令、输出和退出码见同目录 `red.log`、`green.log`，由已返回的工具结果保存；没有重新运行测试来收集日志。原命令三个用例全部失败，duration 2895.827584ms；修订夹具的临时副本三个用例全部通过，duration 3417.379916ms。只执行这三项秒级窄用例，没有运行重测试、真实worker、PTY或真实模型。

绿测副本只在本目录：`creation-fixed.test.mts`、`demo-fixed.test.mts`、`demo-session-fixed.mts`。为使副本沿实际仓库代码执行，测试相对import重定位到原仓库绝对路径，本目录node_modules符号链接指向原依赖；19唯一额外重定位是声明事件类型读取仍固定到原 `packages/core/src/types.ts`。40沿原真实Runtime/Control/CodeState调用，未注入假拒绝；19沿真实Demo构造，只补下文静态样本。副本没有改变断言。

## 根因与最小修复

1. `19-tui-demo:65` 缺少的事件精确为 `task.mcp_operation_changed`。`git blame packages/core/src/types.ts:993` 指向 `b9d8e3d6`（2026-10-23，双端持续MCP），该提交新增事件类型而未同步demo。不是超时、seq竞态或最新28c033f7产生的错误；原测试正确检出合成数据未覆盖声明类型。最小维护补丁在 `packages/tui/src/tui/demo-session.ts` 加三条同ID的 MCP intent → operation_changed(finished) → result，避免只加入悬空状态事件凑过类型表。完整事件集合及连续seq断言原样保留。
2. `40-desktop-creation:29` 用数据目录作为 rejected 夹具；`171cc0b1`（2026-10-24，按实际操作核实范围）已把 createSession/openWorkspace 改为 resolveWorkspaceDir，允许拥有者登记保护目录。对应决定 `.agents/notes/implemented/bug-fix/2026-10-24-operation-specific-checks.md` 和 `10-access-modes:653`、`74-workspace-sessions:338` 明确该行为。故请求真实成功，CodeState选中新建会话正确；`:63`断言失败来自旧夹具前提，非CodeState拒绝处理缺陷。最小补丁只把rejected的cwd换成 `path.join(t.dirs.root, "missing")`，使用当前真实的目录不存在拒绝；保留pending清除、没有切会话、失败消息及零新会话断言。

`fixture-fixes.patch` 只修改两条仓库路径：`packages/tui/src/tui/demo-session.ts`（新增3条静态事件）和 `test/40-desktop-creation.test.ts`（node:path import与rejected目录）。不修改 `test/19-tui-demo.test.ts`、CodeState、Runtime或产品权限规则。应用后可沿red.log同一原命令进行独立复核；本审查没有将补丁应用到主工作区或root的编辑副本。

## 额外候选处理核对

对 `/tmp/ruukoto-reduction-edit-28c033f7` 的当前diff和标题存在性检查：先前报告额外11行候选全部已处理，未发现仍保留的候选。对应为71两项、74个人面板、76重复project查询、33的hStd分支、37五项及119的两个平台展开用例，合计11个完整展开用例加1个内部分支。

注意一处超出先前保守建议的实际范围：编辑副本已删除整个 `119-workflow-im-controls.test.ts`，因此原先报告建议先留的`:16`纯解析用例也被删除；本次只确认这一事实，未替root判定其去留依据。应由实施记录说明旧IM工作流解析入口退役，或保留该负例。此项不影响上述三项baseline归因。

未验证：完整文件组合、全量check、Linux与原四格CI；现有红绿只证明这三项失败的夹具机制与修复，不证明整体基线成功或性能改善。
