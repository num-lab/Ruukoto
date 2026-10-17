# 消息活动、Git横向浏览与本机文档验收

日期2026-10-17，macOS arm64、Node v24.15.0。基点53fad806549622b2fb599550a79beff08cadc130及此前未提交迁移为基线，本轮同步Demo／Desktop；[工单24](../../issues/24-browser-activity.md)是现行入口，sha256.json保存本轮源码及证据指纹。不提交、不推送，不重启日常应用或后台。

## 执行活动

phase-repro.mts调用实际Driver.beginModelRequest／handleSessionEvent，将实际追加事件交给ViewState，再调用正式conversationActivity。phase-red.log稳定捕获请求前、toolcall_start到tool_intent之间、结果到下次请求之间phase=null；phase-green.log相同重放分别持续Thinking、Working、Thinking。这是实际Driver事件链的受控重放，不是provider网络请求或真实模型验收。

activity-red.log记录新增三条前端回归在修改前失败；activity-green.log记录第一轮10项通过。独立复审另用实际EventFlow＋空assistant工具历史抓到reasoning脱离工具组，现分组和最新阶段判断前统一排除无正文无附件message；回归覆盖真实正文、附件、空thinking、Agent和任务边界。Desktop与Demo的SSR断言reasoning是首行、原文只出现一次、孤立reasoning可查，既有Read／diff／完整Bash／错误详情继续有效。正文累计thinking快照由已有投影替换，不拼接；Driver只记录8KiB尾部。

真实Demo从设置切换场景：demo-thinking.json／png确认Thinking下方8px显示演示内容；demo-working.json／png确认Working默认展开、Thought为首行、包含完成与运行中调用。demo-empty.json确认新会话空白，demo-working.json的新标签页只剩浏览器／文件树／可用Git。demo-browser.json确认普通Web Demo的file地址保留，但无iframe且明确需要桌面宿主，没有伪造读取成功。演示内容均明确标记，不冒充模型reasoning。

## Git图

Demo真实量测视口410px、内容445px，主题宽度等于scrollWidth，水平滚动可达35.5px。正式GitGraphPanel的git-browser-fixture.mts使用40条受控提交和超长主题，git-horizontal-red.json记录scrollLeft=5069、scrollTop=1887时自动续页仍为0；原哨兵只有291px宽。把哨兵移到自然宽度ol内后，同位置宽5360px、Loaded pages=1（git-horizontal-green.json）。该fixture直接加载正式组件及CSS，不代表真实Git命令或完整视觉还原。observer回归同时守住末尾观察点属于宽列表；读取错误与重试、隐藏及加载去重沿用原回归。续页无可见文字，以aria-busy表达忙碌。

## 本机文档

Node／HTTP窄回归覆盖Host本地op在离线Code和未配置Personal可用，地址规范化、随机能力、不同并存origin、同目录CSS／图片／module／JSON资源、CORS、方法、Host、路径／编码／链接／敏感文件、预算、并发、释放、Host.close与pending open交错。独立审查真实HTTP发现.envrc与.git-credentials原返回正文（browser-sensitive-red.log），修复后HTTP与直接open均拒绝；完整.env前缀被保护。

browser-fixture.mts加载正式BrowserPanel和BrowserDocuments，仅以受控HTTP桥代替native IPC；CUA在实际sandbox中读取可见output：module:true、bridge:undefined、CSS rgb(12,34,56)、图片宽8（local-browser.png）。随后用两种原生壳单独验证，不把这一步当作原生验收。

Electron使用已构建的正式Main／preload和独立userData，主页面换成同一BrowserPanel fixture；没有改主frame校验、CSP、sandbox或设备权限。可见output的native:true证明使用真实bridge，模块、fetch、样式、图片和子frame bridge隔离通过（electron-local-browser.json／png）。点击实际刷新按钮后，旧listener连接拒绝；退出隔离Electron后当前listener连接拒绝。

MyGo用mygo-browser-fixture.mts构建正式BrowserPanel，复制未改动的Go／preload与正式sidecar到独立标识dev.ruukoto.desktop.browserqa、独立userData的临时app，主文档仍为mygo://localhost/，原trusted校验有效。原生窗口截图可见相同native:true及四项结果（mygo-local-browser.json／png）；该WKWebView未提供HTML accessibility tree，结果由可见截图读取。只读进程／socket核对找到其sidecar唯一loopback监听，退出临时app后端口连接拒绝（mygo-listener.json）。构建／签名见mygo-native-fixture-build.log。临时app不是日常Ruukoto MyGo，没有真实模型请求。

本机能力仅覆盖所选文档目录，敏感元数据、userData和越界资源拒绝；同目录脚本和外部CDN可使用或转交能力，不是任意不可信JS的防泄密执行器。受控导航／刷新／关闭／退出回收能力，不承诺opaque iframe内部自行导航即时撤销。普通Web Demo没有任意本机读取能力。

## 工程验收

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 浏览器／安全／活动／inspector／v4／样式来源／消息恢复／文件树／渲染窄回归 | 83／83 | all-targeted.log |
| 最终Git observer、浏览器、inspector与活动窄回归 | 60／60，与上行重叠 | final-regressions.log |
| check:static | lint、类型、notes、docs通过 | static.log |
| Demo check | 通过，已有大chunk提示 | demo-check.log |
| Electron／MyGo构建 | 通过 | electron-build.log、mygo-build.log |
| bundle签名 | 两种正式bundle通过 | signatures.json |

活动与浏览器由不同只读上下文独立复审，发现的空assistant、敏感名及li ref类型问题已修复并复验，无剩余阻断。完整provider／日常任务端到端及全仓check未运行；没有修改Go／preload，本轮不重复Go race。最终文档改动另跑check:docs。

专用HTTP验证服务、原生QA实例、临时bundle与userData已清理，实现隔离副本已归档；未操作原用户两个标签，验收网页属于随回合回收的临时标签。
