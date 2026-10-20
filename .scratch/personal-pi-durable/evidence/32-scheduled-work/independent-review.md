# 工单 32 最终独立审查

审查者 `/root/scheduled_browser`，2026-10-18。验证工作树 `/tmp/ruukoto-32-browser-1018a` 为 detached HEAD，原基线 `eb0f77c9d2e7adffc784f14064a0e1a51b1d9642`。根工作区全程只读，没有提交或部署。

## 结论与覆盖

对 core 的 scheduler-records/scheduler 和 root 的 scheduler-tools、双平台宿主菜单、CLI/control、来源/权限与 Harness 组合，最终未发现未修实现阻断。重点核对监督 Task/index 双向唯一、原定时会话的 Submission/answer/result 回链、取消授权及不可删除证据、固定目标、漏期合并、每计划一个未关闭运行、发送等待不阻下一周期、最终汇总只有查询资格。恢复及跨期问题由核心作者修改，再由本审查者复验。

`personal-browser.ts` 由本审查者参与实现，不将其本人自检算作独立实现审查；此前浏览器窄测和 BrowserManager 组合探针另归作者验证。真实模型、真实双平台 IM 和真实 Chrome 的外部产品验收未进行；宿主双平台控制/发送测试与 MockModelServer 不能替代真实外部体验。

## 实际命令与结果

工作目录均为上述独立工作树。

```sh
npx tsx --test test/personal-scheduler.test.ts test/personal-scheduler-authority.test.ts test/personal-scheduler-integration.test.ts test/personal-scheduler-controls.test.ts test/personal-scheduler-entries.test.ts test/review-32-recovery-probe.test.ts test/review-32-merge-probe.test.ts
```

exit 0，54/54，通过耗时 5232.094167 ms。原执行没有重定向成日志文件。已将当次工具捕获 stdout 全文转录至 `/tmp/ruukoto-32-final-tests-54.log`；文件头明确标注来源 session 77023 / chunk e1804f，未为落盘重复整套。原工具输出是原始执行证据，该文件是其转录。

核心作者最终 delta 为 `/tmp/ruukoto-32-core-recovery.patch`。最后取消跨期增量仅提取 `mergeMissed`，在正常 finish、计划 cancel 和原生 Task abort 记录合并截止，避免计入取消后周期。对应下表第7个反例的边界扩展；只复核受影响分支，没有扩大重跑：

```sh
npx tsx --test --test-name-pattern '跨下一到期点后先收尾或取消再扫描' test/personal-scheduler.test.ts > /tmp/ruukoto-32-final-cancel-boundary.log 2>&1
```

exit 0，4/4（父测试及 finish/cancel/abort 三分支），耗时 1244.516667 ms。日志 `/tmp/ruukoto-32-final-cancel-boundary.log` 为该次直接重定向的原始输出。最终取消跨期附注已关闭。

root 最后给 Harness 加入“存在 savedSchedules 而 ROOT 缺原 scheduler 扩展则拒绝恢复”的一行 guard；我已静态对照并核实，与现有恢复身份规则一致。该最新一行没有冒充为54项快照已跑测试；静态/最终组合验收分别以 root 的实际命令为准。本次也不替核心作者重报其 tsc/eslint/diffcheck。

## 七个独立反例先红后绿

文件 `/tmp/ruukoto-32-browser-1018a/test/review-32-recovery-probe.test.ts` 与 `/tmp/ruukoto-32-browser-1018a/test/review-32-merge-probe.test.ts` 是临时审查探针；核心正式测试已覆盖对应风险，不要求原样入库。前六例使用实际 openPersonalHarness/SQLite close/open，第七例使用实际 native Harness/SQLite 和可控时间。

| 反例 | 修复前实测 | 修复后独立实测 |
| --- | --- | --- |
| 删除已有 supervisor 索引 | open 错误接受 | 拒绝 schedule_record_invalid |
| summary.submissionId 换 ROOT submission | open 错误接受 | 拒绝 schedule_record_invalid |
| summary.answer 换 ROOT answer | open 错误接受 | 拒绝 schedule_record_invalid |
| initialAnswer 换 ROOT answer | open 错误接受 | 拒绝 schedule_record_invalid |
| 删除 completed run.summary | open 错误接受 | 拒绝 schedule_record_invalid |
| 取消每日计划后删除 canceled/cancelEntry 并恢复未来 nextDueAt | open 错误接受，可掩盖已受理取消 | 拒绝 schedule_record_invalid |
| 活动跨下一期、未等 supervisor scan 即 finish | mergedThrough 留18日，nextDue 已跳20日 | mergedThrough 为19日，nextDue 为20日 |

先红命令及结果：首次 `npx tsx --test test/review-32-recovery-probe.test.ts` 为0/5，均报 Missing expected rejection；补取消例后 `npx tsx --test --test-name-pattern 'deleted cancellation' test/review-32-recovery-probe.test.ts` 为0/1，同报缺少预期拒绝；`npx tsx --test test/review-32-merge-probe.test.ts` 为0/1，实际2026-10-18T00:01:00.000Z、期望2026-10-19T00:01:00.000Z。这些先红输出当时未重定向，不补造原始日志路径。

修后先执行 `npx tsx --test test/review-32-recovery-probe.test.ts test/review-32-merge-probe.test.ts` 为7/7（844.675541 ms），再纳入54/54。正式 core 回归还覆盖外来/重复/非最新活动监督器、删除 initial/summary answer、failed summary answer、孤立 Summary/Result/Send、删除计划/运行取消字段。

## 被审源码 SHA-256

前两文件为 `/tmp/ruukoto-32-core-audit-1018/apps/ruukoto/src/` 冻结终稿，其余为 root 的 `apps/ruukoto/src/`。机器可读记录 `/tmp/ruukoto-32-final-review-sha.json` 同时保存 wide_test_sha256、reviewed_final_sha256、final_verification；表中均为最终已审来源 SHA。

| 文件 | 最终被审 SHA-256 |
| --- | --- |
| `personal-scheduler-records.ts` | `e43c22ac51b73d864eeb839944575e344c36722c4bc5ccea286ee67a5b73f9e6` |
| `personal-scheduler.ts` | `a7bef953cd14b7d8be047325feac0dd412c3226816612e74c1532ba49c525afb` |
| `personal-scheduler-tools.ts` | `cca8b9fe7bf1f22abe76f4c45bd28a9dba240d2726e77b819f192ebbb6d9ee38` |
| `personal-scheduler-controls.ts` | `853b7277bd42bba06d1f1efe6d8382a400a010011b5255dba531741ff7ac80e8` |
| `personal-scheduler-cli.ts` | `6d940995b6f8713e3e643ad1ca72ed90d15262d25ca2deaadbe7b61e8aa4699f` |
| `personal-control.ts` | `e77467ca472032d170c82ddaabbd82d631658a347254dba4f3ed5d6848a2fb4b` |
| `personal-cli.ts` | `bdaca60028a24f9ea14252ce782aa9a3224f96bd6c3ab7e235e367ef6954f8dd` |
| `personal-harness.ts` | `0a30c9cbcb849fc590a96b60ac7b4af8807fd9d0292d33a1d2128dd1f7ea9364` |
| `personal-schedule-authority.ts` | `4d5a582003706a1bbd9944688e517ffdcc70f57fb00ccf44e1abf8fd0503af9e` |
| `personal-schedule-execution.ts` | `634027a64d416a9084ff8f01b637cff6a0a24e2784dc5e9dc233cc2a291edf75` |
| `personal-schedule-scope.ts` | `ef588e13252f60f0d4dba0a06d8e142eacfe1a6d36fa471d27b1565ccb65c745` |
| `personal-source.ts` | `2f7bb23334985c711a5adacfa23cdb29e3386dab6203c1c5bc82714c0dc4652c` |
| `personal-tool-source.ts` | `1c9b0648ab26001944a0dbee288006fdb4faebdad670f1bf7e391656929e9d63` |
| `personal-work.ts` | `b1f7a36e6eb20f21c8d1fadf9dc2343472f5e20c9579808934aba66c207e4dcd` |

54项时 `personal-scheduler.ts` 为 `8fc7a17486a097692c736f4a34ee45b21108e1857f186791fd2320c24f495403`，最终增量通过后续4/4；54项时 `personal-harness.ts` 为 `af6ec64cfcca2ccc4b78224b5ab5fe6dc740ff7d1dc8f114cf463fe4900bb07c`，最新一行只做上述静态复核。其余表中文件与54项源码快照一致。没有将较新源码冒充为整套全部重跑。

## 验证边界

真实模型、真实 IM 和真实 Chrome 均未验证，不可据本审查记为通过。未申请或执行提交、推送、部署或生产切换。终稿无未修实现阻断；完整工程验收与真实环境产品验收仍由 root 汇总各自独立证据。
