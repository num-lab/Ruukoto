# Code 模型设置验收记录

本记录保留原实现的后台／TUI 与初版界面证据；当前模型页已按拥有者要求重写，布局、弹窗、直接测试和最新工程检查以[布局验收](02-layout-verification.md)为准。

日期：2026-10-21。起始检出 `6489df70473b32efa6e839e83c1353fc15b59dcb`，工作区干净，前置设置容器已 resolved。本轮实施 Code 模型管理、纯配置元数据与 TUI 消费，不操作日常档案或真实提供方，不含 Personal 配置管理。

## 工程证据

| 检查 | 结果与范围 |
| --- | --- |
| `npm run setup -- --skip-hooks` | 初始化通过，无依赖清单或锁文件改动；初次与安装并行的测试不作为证据，安装完成后重新验证 |
| `npx tsx --test test/desktop-settings.test.ts test/38-desktop-main.test.ts test/desktop-composer.test.ts test/desktop-session-settings.test.ts test/desktop-settings-models.test.ts` | 123/123 通过；初版桌面模型 11 项及既有会话设置、IPC、输入和容器回归 |
| `npx tsx --test test/18-model-selection.test.ts test/31-model-config.test.ts test/33-config-tui.test.ts test/61-context-compaction.test.ts test/66-control-seam.test.ts` | 88/88 通过；设置纯读与执行／composer 原认证校验分开，覆盖摘要、revision 与控制面 op 表 |
| `npx tsx --test test/31-model-config.test.ts test/33-config-tui.test.ts test/desktop-composer.test.ts test/desktop-settings-models.test.ts` | 71/71 通过；新增动态凭据错误反射、JSON 原型名、默认值丢答、失败读回、测试迟到、真实默认 Effort 落盘回归；桌面模型此时 15 项 |
| `npx tsx --test test/38-desktop-build.test.ts test/43-desktop-demo.test.ts` | 11/11 通过；产物安全检查与定稿样式／组件保持一致 |
| `npm run check:static` | lint、根及所有 workspace／foundation 类型、笔记、文档链接与预算通过；最终 TUI 返工接入后再次完整通过 |
| `npm run desktop:build`、`npm run desktop:mygo:build` | 两壳构建通过；两份应用 `codesign --verify --deep --strict` 通过。Electron 未做 notarization，沿原构建配置 |
| `git diff --check` | 通过；交付前另核对本轮新增文本的单个末尾换行 |

隔离的真实本机 Runtime／ControlServer／认证客户端经 Desktop IPC 白名单驱动写入，模拟提供方仅监听本机。覆盖目录、提供方和模型增改删、存储密钥与单字段目录秘密、默认／摘要、引用保护、受影响提供方忙、跨客户端修订冲突、已写入丢答和读回再失败。存储移除只报告所选条目，其他目录／环境来源仍存在；删除最后可用来源失败时沿原重建回滚。应答、事件、终端、待核实记录不携带秘密值。目录事件使旧分页失效并刷新默认值；新聊天真实会话保留后台默认 Effort，默认刷新失败时不沿用旧默认，明确选择仍可使用。

纯读取回归直接走在线／离线入口及选择器，监测新增 getAuth／checkAuth／OAuth refresh／网络调用均为零；动态目录命令没有执行痕迹，过期 OAuth 字节与进程环境保持。撤回旧 list_models／自动 probe 修复时，真实 TUI 入口用例分别新增 8／1 次 checkAuth 并失败；撤回离线只读存储、秘密占位校验、动态错误固定诊断或安全 JSON 重建时，对应窄回归失败。未通过 mock 掉整个列表排除旧求值入口。

## 浏览器合成验收

Chromium 通过 Playwright CLI 加载正式 App、现有 React／Tailwind Vite 插件及[合成页面](models.html)／[bridge](models.js)。桥仅有合成配置和操作名计数，不记录秘密参数；这些结果不是 Electron／MyGo 或真实模型验收。

- 无会话进入 Code 模型列表，再按提供方、模型详情与存储凭据逐步操作；OAuth 替换／移除说明可见。
- 存储秘密输入后切 PA 触发导航保护，继续编辑保留；保存恰发一次写请求，输入清空。目录秘密输入新值后清空恢复原占位，保存保持禁用。
- 新请求头值在尚未点击添加时也计入草稿；切目标可放弃，切类别可「保存并继续」，原页面秘密随后清空。
- 默认模型／Effort 保存 high，摘要保存后清除；选择 modelOverrides 的具体请求头清除后，provider 请求头和其他高级字段保留。
- 已查看[深色列表](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fcode-models-list-dark.png)、[深色提供方](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fcode-models-provider-dark.png)、[浅色提供方](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fcode-models-provider-light.png)、[430×420 窄窗顶部](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fcode-models-narrow-top-light.png)与[窄窗底部](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fcode-models-narrow-light.png)。窄窗浮窗 clientWidth＝scrollWidth＝396，活动面板 clientHeight＝370、scrollHeight＝1243，无横向溢出，可滚至保存按钮；减少动态效果下继续可操作。
- Tab 可聚焦 Code／PA；方向右键选中并聚焦 PA，Escape 关闭浮窗。并行构建曾使根目录合成 Vite 页重载，重新打开独立会话、等渲染提交后复验方向键通过；不把即时 aria 读取当成功。最终控制台 Errors＝0、Warnings＝0。

## 独立实现审查

`/root/tui_consumer` 独立审查共享后端与 Desktop 元数据消费，不审自己编写的 TUI。直接亲验 runtime API Key 被上游反射与 `__proto__` header 丢失两个反例；返工后重新执行真实本机控制面探针与相关窄测，秘密反射为 false、原字段保留。renderer 新原型名 header 清空后无继承字段、structuredClone 不抛错。真实 Desktop state 读取及默认／摘要导航 authCalls＝0、fetchCalls＝0，仅发 get_model_config。受审基点 `d23acfea`，最终 state 快照 `6eefc56d…`；结论无剩余阻断，不覆盖原生点击或真实模型。

`/root/desktop_test_audit` 独立审查 Desktop 实现与另一作者的 TUI。Desktop 首轮发现目录 model／modelOverrides apiKey 控件缺失、空输入误清、默认／摘要读回与丢答比较、冲突读失败误报、测试迟到、默认刷新失败和真实 Effort 回退、模型 ID 字段定位问题；返工后亲跑最窄回归与真实会话落盘验证均通过。TUI 7 条窄测通过，线上／离线入口无认证求值，未知成员／档位没有静默丢弃或虚构；末轮发现 header 普通输入回显及编辑期间事件刷新修订的竞态，最终复核见下节。

## 最终复核

最终 TUI 返工已在 `c33314ee` 汇总：目录 headers 全程遮蔽，保留 `***`、取消与留空清除，JSON 原型名不丢；编辑动作结束前暂存模型事件，API Key／OAuth 与目录保存均沿原修订，另一客户端写入使原操作冲突且不覆盖。恢复旧明文输入或旧事件刷新路径时，新增真实回归分别失败。作者最终运行 `npx tsx --test test/33-config-tui.test.ts test/desktop-settings-models.test.ts`：40/40 通过（TUI 24、Desktop 16）；随后新增 Code 模型 8 项管理操作拒绝旧 Personal 的窄测 1/1 通过，Desktop 共 17 项。最后来源移除的真实回归证明重建失败恢复 auth.json 字节与修订，界面不报已移除。

独立审查 `/root/desktop_test_audit` 对最终 root 关键文件与返工副本作逐字 SHA 核对，亲跑 TUI 元数据／来源／离线保存 7/7、最后 header／revision 2/2，以及 Desktop 修复回归与最后增量断言；结论 Desktop＋TUI 无未解决阻断。最终 state=`6eefc56d`、UI=`f8107f12`、TUI app=`43da40d7`、model-config=`868dd5cf`、runtime=`be20cf20`。摘要页不会显示仅适用于后台默认值的启动覆盖提示；该单条件调整后两壳重新构建及签名核实通过。完整静态检查在最终 TUI 接入后通过；新增 Personal 拒绝窄测另做根类型与定向 ESLint 核实。

## 产品验收与交接

真实 Electron／MyGo 双壳配置后退出重开、日常后台与 TUI／会话菜单一致性及真实模型连接测试尚未执行。真实模型需拥有者指定测试档案与费用范围；没有这些前提不默认联网、不记通过。Native 构建、签名、SSR 与合成 renderer 均不能替代产品验收。Personal 与其他设置工单未在本轮交付。
