# 个人模型夹具适配交付

2026-10-18，独立worktree `/tmp/ruukoto39-personal-mock-fixture`，基点b1e975437f4cd3ca8084a8b07e451f19ba80ba17。根工作区未写入；只读核对其实际owner系统文字和首尾marker。产品、权限及运行等待未改，本交付是测试脚本协议适配。

`test/helpers/mock-provider.ts`新增PersonalMockModelServer继承原类，仅包装responder：先structuredClone请求，窄认wire system的root首句及最后完整owner来源段落，再只对最后user的精确首尾marker生成替换message。string去一层首尾；array只去首末两个精确text，中间parts保留。raw没有做去标记，原class的calls仍保存实际请求；复制view内替换message对象，避免extract造成messages/raw共享对象时连带改写view.raw。child/report/compaction、来源不完整或marker不完整均原样保留。

34份现有personal测试只把原MockModelServer导入改为PersonalMockModelServer as MockModelServer。新selftest刻意保留原class导入以验证Coding/共享行为不变；没有新生产依赖、私有提示导出或工具注册。系统门限是当前wire测试契约，不进入生产授权。

交付补丁：

- `/tmp/ruukoto39-personal-mock-all.patch`，SHA256 `98476c0b248921f54c087022f16fe3c4cbd064e59cc49954154810daa4944749`。
- `/tmp/ruukoto39-personal-mock-helper.patch`：helper+selftest两文件，SHA256 `498fa1aafd9f526e691b35830d4c962d634cb65d850c9a52266445f5f78a628a`。
- `/tmp/ruukoto39-personal-mock-aliases.patch`：34处单行导入，SHA256 `e765792a27a78059c5d6d134098450952f18e0a59b1da0eaa5491a2276b279dc`。按交付时根文件上下文重渲染，只含机械单行delta，不覆盖主作者新reports/QQ用例；合并补丁已在根只读git apply --check通过。
- `/tmp/ruukoto39-personal-mock-delivery.json`：文件、基点、补丁hash及完整alias清单。

亲跑：`node --import tsx --test test/personal-mock-provider.test.ts`，最终5/5、0skip，约150ms；`/tmp/ruukoto39-personal-mock-fixture-selftest-final.log`。包含原calls/raw保持、局部responder改写不污染实际记录、array首末/中间顺序、历史未剥、child/report/compaction/截短来源拒剥、不完整marker不改、嵌套文字只剥一层、原Mock不变。只用本机回环HTTP，没有真实模型/IM或OS工具执行。

helper与新selftest ESLint通过，日志`/tmp/ruukoto39-personal-mock-fixture-eslint-final.log`；最终根`tsc --noEmit`通过，日志`/tmp/ruukoto39-personal-mock-fixture-typecheck-final.log`；worktree diff --check通过。没有运行产品全套，根负责最终产品/夹具组合与static。

保留的先失败：首轮selftest4/5，在复制view原地改message.content时，其view.raw也随共享对象被去掉marker；测试揭示后改为替换message对象，最终5/5，原日志`/tmp/ruukoto39-personal-mock-fixture-selftest.log`不覆盖。首轮worktree类型检查因尚无apps/ruukoto局部依赖链接解析到Coding Pi而失败；只补指向既有根依赖的worktree链接后通过，没有装包或改根依赖，原日志`/tmp/ruukoto39-personal-mock-fixture-typecheck.log`保留。最初旧基点上下文的alias补丁在根QQ/reports两处不适用，已改成根当前上下文的单行delta；没有执行实际apply或覆盖根文件。
