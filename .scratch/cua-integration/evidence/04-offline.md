# Cua 管理入口工程证据

日期：2026-10-23。基点：`b9d8e3d6`。范围见[工单](../issues/04-configuration-and-deployment.md)，授权与结束标准沿[规格R7／R8](../spec.md#r7-管理与部署)。以下为macOS arm64、Node24.15.0的离线工程与界面夹具结果，不代表真实电脑、模型、SSH部署或本人体验通过。

## 实现

复用原MCP配置、控制协议、设置容器与图片产物。Code桌面／配置TUI选择固定Driver，mcp cua进入原配置向导；检查静态dump-docs及当前后台启动宿主的AX／CG授权位，不启动额外runtime，不借另一daemon的权限。Personal菜单／PA设置选择既有Linux本地沙箱，在线暂停事实随原doc与entry保存；配置写入继续拒绝旧修订及未决动作。安装步骤与固定版本归[操作手册](../../../docs/usage.md#57-mcp-服务)。

恢复页读取原动作与当前观察，Code沿read_artifact完整分页核task／session／产物／哈希／MIME，Personal沿受保护的128KiB图片分页核原观察与完整哈希；桌面全部onLoad后才可接受。CLI导出正确扩展并交系统查看器，失败不取得接受资格。重观察失败废弃旧图，接受仍由后台复核原观察。Code逐服务stop在停止前核实际绑定与全部将停止的原执行，拒绝跨来源停止；暂停异步读回前钉定原服务，不能借配置删除／重选停别的服务。Personal停止暂未核实时保持暂停，重核成功后可以继续，下一次输入仍需先新截图。

## 主工作区检查

| 命令 | 结果与适用范围 |
| --- | --- |
| `npm run check:static` | lint、根及全部workspace／foundation类型、183篇笔记与文档门禁通过；界面精简后完整重跑通过，随后只更新本证据、工单与既有笔记并复核文档门禁 |
| `npx tsx --test --test-concurrency=2 test/cua-configuration.test.ts test/desktop-settings-mcp.test.ts test/desktop-settings-mcp-backend.test.ts test/33-config-tui.test.ts test/personal-settings.test.ts test/personal-settings-blockers.test.ts test/personal-mcp-controls.test.ts test/personal-mcp-config.test.ts test/desktop-personal-settings-pages.test.ts test/desktop-personal-settings.test.ts test/desktop-settings.test.ts` | 180/180，0skip；缺安装／权限、坏制品、保存失败、未决拒绝、旧图／迟到回传、跨档案、暂停停止失败、控制已发送后断流／超限／换代等 |
| `npx tsx --test --test-concurrency=1 test/cua-code.test.ts test/personal-cua.test.ts` | 18/18，0skip；真实产品装配加离线stdio／Linux身份替身，新增停用重观察零发送、配置变化旧接受拒绝、跨来源stop、暂停冷恢复／先截图、停止重核与原unknown不重发 |
| `npm run build:native`后`npx tsx --test --test-concurrency=1 test/native-macos-identity.test.ts` | 18/18，0skip；包含新的两项无提示权限预检，原持久身份／停止回归 |
| `npx tsx --test test/desktop-settings-mcp-backend.test.ts test/29-cli-entry.test.ts` | 23/23，0skip；与180项有重叠；CLI mcp cua进入原向导，原PNG分页导出与失败保原目标 |
| `npx tsx --test test/desktop-settings-mcp.test.ts test/desktop-personal-settings-pages.test.ts` | 界面精简后49/49，0skip；保留原恢复、图片校验与错误显示 |
| `npm run desktop:build`、`npm run desktop:mygo:build` | 两个darwin/arm64壳构建通过，界面精简后重建通过；构建的体积、inlineDynamicImports等提示未改打包策略 |
| `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Ruukoto.app`及同命令检查`dist/mygo/darwin-arm64/Ruukoto MyGo.app` | 均valid on disk并满足Designated Requirement；本地ad-hoc，不是发布签名或公证 |

不重复Node22／24 stdio传输矩阵：本单不改传输，既有证据归[03](03-offline.md)。Linux发现使用本地文件／Docker只读夹具，未据此声称user systemd或guest连接已验收。

## 浏览器界面核实

以实际React设置组件、构建后的CSS和离线桥接替身在127.0.0.1打开；PNG由浏览器canvas生成，明确标注OFFLINE RECOVERY FIXTURE。浏览器只核图片展示与事件，不连接Cua。Code及PA图片均complete=true、naturalWidth=640、naturalHeight=320；Code失败重观察后图片与接受资格消失，再读回同一旧观察也不能接受；PA点击接受实际发送原operation=42／observation=99。初版页面截图：[Code](04-code-browser.png)、[PA](04-personal-browser.png)。查看器不会据此宣称读过真实桌面。

拥有者要求按布局说明操作，删除两端MCP页的重复范围、后台保证、常驻恢复提醒与原始证据正文；新服务按钮表达保存草稿，恢复页按当前阶段、截图、确认操作呈现。保留实际错误、图片接受检查和Linux停止丢失未保存状态的确认。精简后1280×1000浏览器夹具核实两端图片加载后确认可用、确认位于图片之后、Code失败重观察显示错误并废弃旧图，Personal确认仍发送原观察99。当前截图：[Code](04-code-cleanup-browser.png)、[Personal](04-personal-cleanup-browser.png)。

首轮Code浏览器脚本把“失败后接受按钮消失”误写成“按钮仍存在但disabled”，等待不存在的locator超时；改为接受消失或disabled并在读回旧观察后再断言，结果通过。页面唯一资源错误为未提供favicon的404，不影响组件。临时浏览器与只读HTTP夹具在结束时关闭。

## 独立审查与原失败

独立上下文check_design直接核规格及实际shared discovery／runtime／Code Desktop与TUI，亲跑两文件45项，最终Cua窄例7项；另外构造多服务未核实执行，逐服务stop在任何helper副作用前拒绝跨服务停止。发现的暂停删除竞态补了先红后绿的最窄state用例。native权限预检由另一上下文backend_survey复核，亲跑2项权限预检及Code UI／TUI／CLI 7项；作者原副本的23项原生身份／helper和5项原生执行也通过，不替代主工作区记录。

Personal由独立上下文personal_review直接核暂停／恢复／图片／设置控制；原88项通过后，新增反例捕获closeCua停止暂失败会永久残留不可用标记，删除本次新增残留赋值后可重核并恢复。另以真实HTTP已执行请求证明：控制应答超限及收答后连接换代曾误报not_sent，现沿mutation归unknown，两个用例先红后绿。原unknown／remoteEnded、普通HTTP阻塞和暂停冷恢复均保持。新增cua_paused模型可见结果明确未接纳与从管理入口继续，实际离线请求核实通过。

界面精简由独立上下文ui_copy_review核对实际组件与状态，亲跑10项Cua／SSR窄回归。首次修正按ready阶段隐藏消息，误藏发现失败、图片校验及权限错误；改为仅在明确成功分支清除成功提示，始终呈现非空错误。实际State加SSR反例证明发现被拒的消息仍显示，冗余提醒消失；无未解决阻断。

其他首轮失败：独立原生副本缺worker产物，补build:worker后原生执行5项通过；新Linux发现夹具在macOS未规范化/var路径，改为真实路径后3项通过；根类型发现负例中number需构造EntryId，已修；README／development预算首次超限，合并命令说明并删重复措辞后通过，未提高预算。Code原假Driver补dump-docs静态分支，零runtime启动断言保持。

无未解决工程阻断。真实两端安装选择、宿主权限／guest连接、系统图片查看器、正式Electron／MyGo操作、模型视觉与拥有者暂停继续和丢答恢复仍待人工及05验收。没有运行全量npm run check，没有部署、发布或操作旧实验容器。
