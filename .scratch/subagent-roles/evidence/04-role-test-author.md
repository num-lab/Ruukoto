工作流角色集成窄测试验证

最终新增文件：test/workflow-role-integration.test.ts。除该新文件外，测试副本仅同步主仓生产代码；交付补丁不含生产文件。

实际覆盖共9例：

- ruukoto/ruukoto-code 各1例：真实父Driver与普通target reviewer、工作流target reviewer，真实bash读取dirty/staged/new当前内容，源写入被拒；模型工具、权限、角色digest与source快照一致；运行固定角色目录不采用后来full_access新配置。
- 1例：默认general、自定义full_access角色的verify保存confirm/protectSource且仅编码工具；零工具passed:true得到failed验证与skipped汇入。
- 4例：成功修改、验证并停在ask后，定义缺失、execution缺失、target snapshot缺失、旧interface冷恢复均暂停；所有旧Task与执行记录、尝试、来源与两个副本字节不变，resume不能绕过。
- 1例：临时脚本已真实write并冻结后遇旧mode，明确暂停，恢复请求拒绝，不重新执行或覆盖成果。
- 1例：角色tools与步骤tools不匹配在Agent Task/模型请求前拒绝。

验证命令与结果：

1. npx tsx --test test/workflow-role-integration.test.ts（workflow-role-tests-final.log）：6例通过；reviewer两例因手工父Task缺真实活动Driver失败，之后修为holdParentResponse+rt.submit；definition_missing在并发原生期间遇identity_unavailable且未到ask，之后独占重跑。该整组不是通过记录。
2. npx tsx --test --test-name-pattern='^ruukoto' test/workflow-role-integration.test.ts（workflow-reviewer-tests.log）：修正夹具后的双产品2/2通过，0 skipped，47.1秒。
3. npx tsx --test --test-name-pattern='ask 后冷恢复遇到 definition_missing' test/workflow-role-integration.test.ts（workflow-definition-recovery-tests.log）：1/1通过，0 skipped，12.5秒。
4. npx tsc --noEmit（workflow-role-types-final.log）：通过。
5. npx eslint test/workflow-role-integration.test.ts --max-warnings=0（workflow-role-lint-final.log）：通过。

最终9例均有通过证据，未重复已通过且未受夹具修正影响的6例。初轮SQL NULL违反NOT NULL、旧mode恢复本应拒绝等夹具失败保留于workflow-role-tests.log；不作为产品失败或通过依据。

测试环境为macOS、模拟模型服务、真实Runtime/Driver/worker及原生执行。未跑真实模型和Linux；未扩大到smoke矩阵。主仓最新源码与被检副本差别仅Note锚点及workflow工具一处同义措辞，无行为差异。
