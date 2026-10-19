# 工单 39：ready 最终收尾补丁复核

结论：此前整体timeout收尾阻断解除。

最终完整 patch `/tmp/ruukoto39-personal-durable-ready-cleanup.patch` 的 SHA-256 为 `cef442b75bb742583ef213d8f76f22bab1946b84428550cc7572d479b6703d50`。与旧 `f36cf9d6b5ec02edb3256f2b1dc98e485200252cc358775f16d821535fa620b9` 比较，运行代码只新增4行：本例cleanup回调数组、fixture创建前先登记await全部close的t.after、launch入口t.signal.throwIfAborted、每个句柄close入列；另更新既有note说明。

这些代码与此前 `/tmp/ruukoto39-durable-ready-timeout-audit/fixed.test.ts` 已验证的修法一致。Node after按登记顺序执行，故所有本例子进程先kill并wait close，才执行fixture关闭server和删档案；signal守卫防整体timeout后仍在继续的函数创建新child。原各分支finally、ready在open前、ready10秒、partial5秒、整例15秒及原kill/reopen/历史断言均保持。

沿用先前正常单例1/1与整体timeout反例的对照证据，不重复15秒故障注入或作者Node22/24整文件检查。未修改根、作者副本或live；本结论解除旧版f36的收尾阻断，不覆盖其他未审变化。
