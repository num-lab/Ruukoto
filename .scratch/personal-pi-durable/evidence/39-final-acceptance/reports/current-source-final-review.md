# 当前模型输入身份投影独立审查

2026-10-18，针对工单39的QQ新拥有者输入被模型误述为历史宿主参考一部分的问题，只读核对最终实现与窄验证。根工作区由主Agent独占写入；本审查未写根仓库、未操作live档案或IM、未读取凭据、未发真实模型请求。结论：当前改动无生产实现阻断。它补充模型输入的当前来源事实，不是消息合并修复，也不改变权限。

## 审查结论

- `personal-harness.ts`从当前会话唯一活动Submission取持久entry引用，再从事务读取该entry的kind；不按用户正文、历史参考中的措辞或模型自报选择身份。仅`pi.user`与`ruukoto.delegation-report`取得各自明确说明，未知或缺失kind没有默认拥有者身份。
- 动态`personal-current-source`只加入ROOT会话且输入首system已含宿主`sections.personal`的请求。条件读取的是进入prepareInput前的结构，压缩使用自身摘要system，同session仍有活动拥有者输入也不取得拥有者说明。子/定时请求没有该主会话说明。
- 旧参考和新拥有者消息仍各自保留。事实进入现有model-request的input和实际payload；不重写、删除或重新投递已保存参考。拥有者仍可要求查询旧事，文案没有强制新建工作或替拥有者决定本轮任务。
- 浏览器、报告只读工具及原来源守卫保持独立；报告说明不赋予拥有者或浏览器资格。未知来源仍被原委派守卫拒绝。模型可见事实不是新的授权依据。
- 新压缩用例的最终顺序已复核：`until`、`compact`及断言均在try内，finally先release再await原owner；fixture关闭前收齐该进行中回答。此前提出的失败收尾问题已解除，最终单例复跑通过。

真实QQ边界只采用已脱敏摘要：实际payload中旧宿主参考和新QQ输入是相邻、独立的user项；后者不在旧参考字符串内，旧空错误assistant被SDK略去。模型误读该边界并只查询旧工作，不能据此声称宿主曾合并消息。原始IM材料未在本报告扩散。本次离线验证证明输入事实及守卫，真实模型是否按新事实正确理解须由后续真实验收证明。

## 独立验证

关联最窄集6/6通过，无skip，约1.55秒：失败参考后的拥有者输入、拥有者在途时的实际原生压缩、报告只读限制、配置浏览器的真实报告、原完全访问拥有者浏览器资格、定时真实来源筛选。日志：`/tmp/ruukoto39-current-source-independent.log`。

独立实际Harness未知kind负例1/1通过，无skip：新造`test.unknown-reference`提交未取得动态来源section，模型的delegate调用得到`work_source_invalid`，新后台工作数0；两次请求均为本机MockModelServer。事实：`/tmp/ruukoto39-current-source-proof/unknown-kind.json`；源码：`/tmp/ruukoto39-current-source-proof/proof.test.ts`；日志：`/tmp/ruukoto39-current-source-proof/run.log`。

最终收尾顺序修改后，单独重跑“拥有者轮次运行时的原生压缩”1/1通过，无skip，约1.79秒。日志：`/tmp/ruukoto39-current-source-final-compaction.log`。没有因同一行为重复全套验证。

最终核对SHA256：

- `apps/ruukoto/src/personal-harness.ts`：`b3568a02d0dfa9cf8d66df78036f7988eee09826e9c8cc519c11fd12c7853c3b`
- `test/personal-reports.test.ts`：`22448bbde8b71eff9fac79c883cf15c374c835ca8dff6136d394a0d28db7574a`

## 证据清单与范围

- 本审查：`/tmp/ruukoto39-current-source-final-review.md`
- 关联六例日志：`/tmp/ruukoto39-current-source-independent.log`
- 未知来源探针及事实：`/tmp/ruukoto39-current-source-proof/`
- 最终压缩单例：`/tmp/ruukoto39-current-source-final-compaction.log`
- 先前结构核对：`/tmp/ruukoto39-compaction-shape-proof/shapes.json`与同目录日志；该下层fixture仅证明压缩system形状，主会话正向事实由本次实际PersonalHarness用例证明。
- QQ边界只引用脱敏事实：`/tmp/ruukoto39-qq-boundary-sanitized.json`，不复制其业务正文，不列私有原始包。

主Agent的原红日志、static检查与真实模型后续证据不记作本审查亲跑。本改动增加系统提示文本，最终真实请求快照仍应按共享estimateTokens的方法记录systemPrompt增量；toolSchemas由本改动保持不变。
