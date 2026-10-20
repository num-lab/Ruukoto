# 工单 39：browser/report 来源筛选实施独立审查

结论：不阻断。两个新增运行代码行只在已通过当前唯一活动candidate校验后，读取entry并对精确ruukoto.delegation-report返回false；报告没有浏览器资格。没有catch来源错误、没有把报告映射成拥有者、没有改personalSource、record或浏览器调用时的origin授权。

## 核对对象与机制

运行前后 SHA-256 保持：personal-browser.ts 为 `f590c22cb020e43638c3049c3f267df19a28e94fc53c5619ea934cdd9a14153b`，personal-browser-integration.test.ts 为 `df87003d946512e51fb06f96e1711b4e35b18e9afefa9886f6b8028fd1e0c810`。已读对应note/docs补充，与当前只移除浏览器定义、不提供新授权的行为一致。

entry缺失或其他kind不会命中新增分支，继续调用原personalSource(active=true)。候选本身缺失、会话或当前input不匹配仍保持原false；并没有将这些旧行为统一改成异常。browser筛选返回false后，prepareInput仍移除browser工具。record中的personalReportRequest仍在append模型请求之前运行，对已登记的报告输入、任务活动状态、原文/attempt、成员停止及原委托暂停条件独立核实；新增分支未替代或跳过它。

定时源由personalScheduledSource处理，其entry为既有定时类型，不匹配报告kind。原full_access加创建时scope.tools/extensions条件保持；子工作也没有继承拥有者浏览器权限。

## 独立最窄运行

执行 `node --import tsx --test --test-name-pattern='已配置浏览器不阻断委托汇报|browser仅主会话原完全访问|定时请求发出前按本会话真实输入筛选' test/personal-browser-integration.test.ts test/personal-browser.test.ts`：3/3通过、0跳过，约1.64秒。日志 `/tmp/ruukoto39-browser-report-independent.log`。

新增组合用例使用实际openPersonalHarness及browser配置，真实走委派、封组、宿主报告、background_work result查询、local报告完成；两次汇总模型请求均无browser，浏览器命令次数0。普通full_access拥有者请求仍含browser；原confirm排队来源不随默认变化扩权、子工作不含browser的用例保持。原定时筛选窄例仍允许本定时会话，拒绝主会话借用该来源。

另以实际browserRequestAllowed加最小Tx分支double核对三条失败路径：未知kind、entry记录缺失、entry ID缺失都抛原PersonalError(source_invalid)，且发生第二次submission读取，说明仍进入personalSource；精确报告kind返回false且只读取一次candidate。该探针不冒充真实持久化组合，源码与结果分别为 `/tmp/ruukoto39-browser-report-source-branches.mts`、`/tmp/ruukoto39-browser-report-source-branches.json`。

## 范围

未改根或作者副本，未读取凭据、未访问live-profile，未运行真实模型/IM或真实浏览器。只有离线MockModelServer回环调用及分支probe；不重复全量browser/report集合或static。后续真实组合验收由根及acceptance_map持有。
