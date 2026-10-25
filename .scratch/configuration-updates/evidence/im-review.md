# 配置更新：IM 独立实现审查（阶段记录）

审查时间：2026-10-25T11:41:53.502119+00:00。基点提交：`e84ae1c9c861fa9d49fbfbc0aab7c616ccb37f67`；对象为其上的未提交实现，以末尾 SHA-256 为准。

后续两处关闭修复已由另一上下文复核，最终结论见[设置审查](settings-review.md)与[IM/执行审查](im-execution-review.md)；本篇保留阶段反例与原指纹。

## 结论与范围

对规格 R3、共同契约的新旧操作与权限收窄，以及 A8 的平台接纳、固定发送句柄、候选配对与未知外部事实进行独立审查。原实现的问题续答和定时新输入未检查切换/设置暂停，已由 IM 作者修复；当前针对性 22 项检查通过。主/子/定时消费方按符号检索复核，切换临界区只包提交与句柄固定，模型等待和网络发送在临界区外。此结论不覆盖本上下文编写的模型/MCP/搜索运行时与设置基础层，也不计作其独立审查。

## 阻断与复核

- 已解除：问题续答及定时 run/summarize 在平台锁内核实 isActive；旧已提交输入按原 requestId 重连，暂停只禁止新输入，不重放旧业务。
- 反向验证：在 `/tmp/ruukoto-config-runtime` 仅撤去 scheduler 对 isActive 的调用，保留其余最终代码和真实平台协调器，suspended/switching × run/summarize 四子例全部失败：额外模型请求分别从预期 0/1 增为 2。主区最终实现的相同子例全部通过。
- 另发现无活动 IM 也异步 close 导致 Harness.closed 后锁尚未释放；原 durable 两个 StorageFailed 子例与 work 登记失败例独跑稳定 profile_busy，修复后的原检查共 4 项通过。这一小段 close 修复由本审查上下文实施，不能以作者自检充当独立审查。
- 另发现 QQ 配对候选提交失败后，连接已经停止但 rejected pending 阻止放锁。已注入真实 Storage.commit 失败复现，并交 `ruukoto-pairing-failed-evidence-close.patch`；关闭路径只等待已报告候选 settle，连接停止错误仍传播，read/confirm 不使用失败候选。本段亦由本上下文实施，待另一上下文独立复核。

## 亲验命令

```sh
npx tsx --test --test-name-pattern='在线换绑|旧凭据缺失|后台配对|配对回执|设置暂停|后台最终报告固定|QQ问题|原菜单逐题|回报认领后丢答|最终发送等待' test/personal-telegram.test.ts test/personal-qq.test.ts test/personal-scheduler.test.ts test/personal-reports.test.ts
```

结果：22/22 通过，4.0 秒。包含真实后台进程凭据配对、TG submission 与 sending 两窗口、QQ 在途连接保留、问题续接、定时未知发送与平台切换；平台服务由受控回环替身提供。

```sh
npx tsx --test --test-name-pattern='真实持久记录写失败关闭 Harness|工作登记写失败' test/personal-durable.test.ts test/personal-work.test.ts
```

作者修复验证：4/4 通过，2.7 秒；原失败现象已先独跑复现，未通过延长等待修正测试。

## 未覆盖

拥有者已明确暂不做 Telegram/QQ 真实账号外验；受控 API/OneBot 不证明实际平台可用性。真实 Keychain、MyGo 实机、真实服务部署与产品验收不在本 IM 审查通过项内；Electron 隔离交互另记。后续主区若改变本范围源码，按改变部分更新指纹并复核；服务 host 基线修复仍在实施，A9 结论另记。

## 文件指纹

| 文件 | SHA-256 |
| --- | --- |
| `apps/ruukoto/src/personal-im-api.ts` | `143d113d05018fa80267bb84679c8537032006b489ab5a442ba4376b8dee908d` |
| `apps/ruukoto/src/personal-telegram.ts` | `f0bd07c3a55dd811ab4d9dde10eccb15678dd08413c9205de251a3eef952a31c` |
| `apps/ruukoto/src/personal-im-pairing.ts` | `2c11f07c80d8191c3cab847b66baa14aaa2d23ed66ae97c19e55a3019f020792` |
| `apps/ruukoto/src/personal-harness.ts` | `4b09ba97c93a6a3c0b2030a54837967ca7dac8c5ac07adced2e455186184d345` |
| `apps/ruukoto/src/personal-questions.ts` | `a72db02a7a4c35155dd02017cf7e2f4e288593d0f3b8aa4e8ef9334d72d95e46` |
| `apps/ruukoto/src/personal-report.ts` | `c872ed0844925fc20f0bed4bb9730cf8b07797121bf0c90f1e0f82f9669805de` |
| `apps/ruukoto/src/personal-schedule-execution.ts` | `3924d43a35aa884ca3cf1b426cac3ea65dd368cb90ded33abb8c2c3fe533bbf9` |
| `apps/ruukoto/src/personal-scheduler.ts` | `dd6d8434d4178c87e854b6c4ac22cdd8f0447e471df204da4596d6e7a802ca55` |
| `apps/ruukoto/src/personal-qq-api.ts` | `04575510899fb536f3501a209c4bb29e28b2edaea98f933a17060d09583828ec` |
| `test/personal-telegram.test.ts` | `101c7db9737ef4f5e68463b21b323f7396c2d737f8655c3a50ba592695bca0d7` |
| `test/personal-qq.test.ts` | `29a82237c2890bd081597b44071e5a20c46fe0cafb51b4bc43b7f987038e7224` |
| `test/personal-scheduler.test.ts` | `163e75bf74ccb6edcc73bb27a5d1022f0df75ce58a128c64abf197a77d9cc8a5` |
| `.agents/notes/implemented/architecture/2026-10-25-personal-im-updates.md` | `00c9a14355b47e6bb763541b48da1f7a69df7361c330381ab3659c27a91e9922` |
