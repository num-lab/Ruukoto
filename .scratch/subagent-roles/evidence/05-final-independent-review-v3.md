# 05 最终独立审查 v3 补充

独立审查通过：第28个unique修复文件仅为14历史分页用例的一行异步同步，完整正文、唯一正文、实际48KiB后续页、UTF-8偏移及滚动断言均保留；没有生产修改。最终固定63项输入、28个修复文件与主区一致，28个修复文件与独立私有workspace解析副本逐项同字节。v2的62项全部未变，仅增加test/14-tui-app.test.ts；原v1/v2报告、清单与归档不覆盖。

独立读取实际代码确认：startApp只等待连接online；TuiApp.loadHistory先安装默认16KiB历史，再await restoreEventFlow；readTaskFlow逐页apply持久output_fragment并refreshTranscript，EventFlow.reconcileMessage可使正文完整且非streaming，之后才遍历missing并await loadEntry，先等offset0响应，再发offset>0后续页。loaded集合在读事件前排除truncated assistant，task.output_entry加入missing；正文大于48KiB，因此后续分页仍是实际必经操作，完整正文谓词并不保证它已发生。

独立审查临时门控探针：真正发送offset0请求后，仅延迟它返回给调用方的Promise；测试真实等待正文恢复和首请求，记录fullBodyRecovered=true、uniqueAnswers=1、firstPageRequested=true、laterPageRequestedBeforeRelease=false，再释放门。该探针只在独立临时副本使用，不进入最终测试或生产。

本上下文亲自执行旧门控脚本：0通过1失败、0跳过、exit1、2876.766333ms，同原48KiB断言失败；新门控脚本：1/1、0跳过、exit0、3108.543208ms。两次真实打印相同门释放前状态，证明旧同步断言确有可重复竞态。最终去门控文件亲自最窄：`npx tsx --test --test-name-pattern='^长正文生成中退出后冷重连：' test/14-tui-app.test.ts`，1/1、0跳过、exit0、3609.317541ms。临时脚本仅运行该mock模型长正文场景，没有真实模型或native工具。

最终一行保留原完全相同requests.some谓词，只由立即assert改为await waitFor默认15秒；无sleep、无显式预算提高，无删断言或改生产。被检文件SHA256为bb1debf2e94aa6e9f2207353282e132d042137d75d28e1ba3c38804e77bc105f，补丁SHA256为0b86744c32c0df96ced188c8c7da20368e09ca2ece9f2b19c6281f623f46bdc2。精确来源代码、诊断脚本和日志摘要见05-history-pagination-independent-inputs.json。

本结论只关闭14测试缺同步；不解释122六输入原90秒未完成或其他历史超时。Linux原完整检查实际1640通过、5失败、13跳过、1507.241秒，原exit1和原冻结输入必须保留。后续修补/分组通过不能改称原full绿，也不能把本次63项清单当作Linux原full的输入。原两项实现阻断、R1–R14及外部/产品边界继续见未改的原独立报告与v2补充，真实平台和拥有者体验不自授通过。
