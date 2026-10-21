# 后台TUI实时刷新与操作应答增量独立审查

结论：无未解决阻断。原分页、关闭原键、日志与重连提示结论继续有效；此前TUI文件hash对应结论由此增量更新。

列表refresh继续按session/instance/generation核实，只接纳最新读取；stop/end的应答不再依赖列表查询代次，因此实时changed触发的refresh不会丢掉操作结果。两类操作的成功、catch和finally均按原session/instance保护，旧操作不能改写其他会话的提示或触发其刷新。日志保留独立outputRead代次，未受本增量改变。

## 实际验证

- npx tsx --test test/background-process-clients.test.ts：15/15通过，无跳过，162.573958ms。新增refreshDuringAction用例在后台stop/end应答之前先await真实面板refresh，两个结果都可见，单停不再残留“正在登记停止”。
- node --import tsx /tmp/ruukoto-background-action-review-20261021.mts：公开按键发出stop/end并保持应答，切到其他会话后才释放。stop成功、stop失败、end成功、end失败四种场景通过；旧message不出现，旧finally不对新会话额外发起列表读取。
- 此次不运行监督器，只读主工作区。

## 被检内容 SHA-256

- `packages/tui/src/tui/background-processes.ts`：`1cb5abe7bc43aa3a9a4849453436c067e2e6853eb84a8feaf540cc2ab7ef7f0c`
- `test/background-process-clients.test.ts`：`9b3fdd5e2601674bd7bc716114c8db19348fbcd500790a01ba36a42a45d64cc3`
